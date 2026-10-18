# Litestream → R2 backups, and surviving a server that lost history — design

Date: 2026-10-18. Branch: new branch off `master` (owner merges).

## 1. Why

flako.in runs on **Render's free tier** (Docker, deploys on every push to `master`), proxied by
Cloudflare, kept warm by UptimeRobot pinging the `onrender.com` URL. Render's free disk is
ephemeral: every deploy (and any platform restart) starts with an empty `/data`, so every note is
wiped.

The owner's priorities, in their words: data loss is *not* a big concern (it's an open notepad;
anyone with the name can read or wipe a note). **The worst case is the app going down.**

So this project has two parts:

1. **Litestream → Cloudflare R2:** restore the SQLite file on boot, stream changes while running.
   Notes survive deploys, best effort.
2. **"Server lost history" fix (a live bug today):** when the server's op log is behind what an
   open tab has (DB wiped, or a restore that is missing the last seconds), tabs silently diverge.
   Make the client detect it and repair.

## 2. Goals, non-goals, anti-goals

**Goals**
- Notes survive deploys and restarts in the normal case; losing the last ~10 s of edits on a crash
  or during a deploy is acceptable.
- Open tabs never silently diverge after the server loses history; they detect it and re-send what
  they have, so in the common case (someone had the note open) nothing is lost at all.
- Zero cost: R2 free tier (10 GB, 1M writes/month, 10M reads/month).
- Backups can be switched off by removing env vars — no code change, and the app behaves exactly
  as today.

**Non-goals**
- More than one serving instance; point-in-time restore UI; backing up anything but the DB.
- Removing the Oracle/Caddy/Compose path. It keeps working (Litestream optional there too).

**Anti-goals — this fails even if backups "work", if:**
- the app fails to start, crash-loops, or a deploy fails health checks **because of anything
  backup-related** (R2 down, wrong/missing keys, quota exhausted, slow restore, corrupt restore,
  Litestream crashing);
- secrets land in the repo or image;
- the repair in part 2 can make a healthy tab lose or duplicate visible text.

## 3. Facts verified (2026-10-18)

- Render: zero-downtime deploys apply to free web services: the new instance boots and must pass
  the health check / port check before traffic switches; the old one then gets SIGTERM and has
  **30 s** before SIGKILL (render.com/docs/deploys). So old and new run side by side briefly.
- Litestream current release is v0.5.x (LTX format, single replica per DB). R2 is supported as an
  S3 replica: endpoint `${ACCOUNT_ID}.r2.cloudflarestorage.com`, region `auto`; v0.5.8+ limits
  upload concurrency for R2 automatically (litestream.io/guides/s3-compatible).
- `litestream restore -if-replica-exists` exits 0 when there is no backup yet; network/permission/
  corruption errors still exit non-zero. **No built-in timeout.** (litestream.io/reference/restore)
- `replicate -exec CMD`: Litestream exits when the child exits.
- **Unverified:** what happens when two Litestream processes (old + new instance during a deploy)
  replicate to the same R2 path. Must be tested (§6).
- Server already handles SIGTERM (10 s graceful shutdown) and serves `GET /healthz`.

## 4. Part 1 — Litestream (decided)

**Startup script** (POSIX `sh`, the container entrypoint), in order:

1. If the R2 env vars are not all set → log "backups off" and `exec flako-server` (today's
   behaviour).
2. **Restore with a time limit** (≤ 20 s total with the check below, `timeout`) into a temporary path, using
   `-if-replica-exists`. On success, check it with `sqlite3 <tmp> "PRAGMA integrity_check"`
   (add the `sqlite` apk package); only an `ok` result is moved into `DB_PATH`. On timeout, error,
   or a failed check → log loudly and start with an empty DB. **Never exit because of a restore.**
3. **Run the server as the main process and Litestream beside it**, not as its parent: Litestream
   crashing or failing to authenticate must not take the server down. (Owner's call by priority;
   `replicate -exec` was rejected because Litestream dying would kill the server.) The script
   forwards SIGTERM to the server, waits for it to exit, then signals Litestream so it makes a final
   upload, waiting at most ~15 s (inside Render's 30 s).
4. Server exit code is the container's exit code.

**Config:** a `litestream.yml` in the image that reads everything from env vars:
`R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (set in Render's
dashboard). Sync interval **10 s** (keeps worst-case writes ≈ 260k/month, under the free 1M).
Snapshot/retention: keep R2 small (e.g. daily snapshot, short retention) — builder picks values
that the v0.5 config actually supports and notes them.

**Image:** pin a Litestream v0.5.x release binary (checksum-verified) in the Dockerfile. Still runs
as the non-root `app` user.

**Render settings** (documented, done by the owner): health check path `/healthz`; env vars above.

## 5. Part 2 — "server lost history" (decided)

**The bug today.** A client remembers `have` (highest contiguous seq it has). After the server's
log is wiped or rewound:
- reconnecting with `hello{have: 50}` when the server's latest is 45 → server sends nothing;
- if others already pushed the new log past 50, the client skips new ops 41–50 that are *different*
  ops reusing those numbers;
- edits the old server acked are gone from the server and from the client's outbox → never re-sent;
- the client may upload a snapshot labelled `upTo: 50` that newcomers trust, skipping real ops.

Comparing seq numbers alone can't catch the "server already went past 50 again" case, so:

**Mechanism.** Every op's IV is random and unique. The client remembers the IV of the op at its
`have`. `hello` gains an optional `haveIv`. The server looks up its op at `have`: if it doesn't
exist or its IV differs, the log was rewound — it replies with a welcome marked `reset: true` and
catches the client up **from zero** (snapshot path, as for a fresh client). Old clients that send no
`haveIv` get today's behaviour.

**Where the client gets the IV (builder's call, settled in review).** The tab may reach `have` via a
snapshot and never see the op at `have`. So the server includes `seqIv` (the IV of its op at
`welcome.seq`, empty when 0) in `welcome`; ops carry their IV already; for its own acked ops the tab
uses the IV it sealed. The tab keeps only the IV for its current `have`. Ops are never deleted, so
the op at any `have` ≤ latest exists unless the log was rewound.

**Client on `reset`:** clear `have`, the received-set and the snapshot bookkeeping; apply what the
server sends (the CRDT ignores duplicates, so text the tab already shows doesn't change); once
caught up, **re-send only what the server's catch-up did not contain** — the tab knows which element
ids and deletes it just received, so it sends its remaining inserts/deletes. Several tabs resetting at
once may duplicate a little; that's harmless and bounded by note size. A tab resetting after another
already repaired the note sends nothing. Use the existing frame/batch splitting; queued and outbox
edits keep their current order and path. No snapshot upload until caught up (existing rule).
(Builder's call, settled in review — avoids N tabs each re-writing the whole note.)

This also covers a deploy: tabs connected to the old instance during the overlap reconnect to the
new one, detect the rewind, and re-send — so the overlap loses nothing for anyone who had the note
open.

## 6. Must be tested

- **TDD (engine/hub tests, fake hub + Go hub tests):** rewind with server behind; rewind where the
  server already passed the client's `have` with different ops; old client without `haveIv`;
  repaired state converges for two tabs and a newcomer; no visible text change for a healthy tab.
  Mutation-check the IV comparison.
- **Startup script, locally with Docker + a local S3 (MinIO) standing in for R2:** no env vars;
  wrong keys; unreachable endpoint; restore hanging past the limit; corrupt backup; Litestream
  killed mid-run (server keeps serving); SIGTERM gives a final upload. In every failure case the
  server must answer `/healthz`.
- **Two writers:** run two Litestreams against the same bucket path (simulating the deploy
  overlap), then restore. If the backup can break, switch to a per-boot replica path
  (restore from the newest) and record why.
- **Real thing (owner, after merge):** create a note on flako.in, push a trivial deploy, the note is
  still there; and with a tab open across the deploy, its edits survive.

**Settled in review (builder's calls):**
- The per-boot-path fallback is a **gated task**: planned briefly, built only if the two-writer test
  shows a restore can fail or yield a corrupt DB. Losing the old instance's last upload is fine.
- Restore happens before the server listens. Total budget **≤ 20 s including the integrity check**.
  Deploys are zero-downtime (the old instance serves meanwhile) and UptimeRobot prevents cold
  starts, so this only delays a rare platform restart.
- The startup script is the image's entrypoint for both Render and Compose (no env vars → backups
  off). Port handling stays as today (it works on Render now); don't add `PORT` support.
- Retention: daily snapshot, keep ~3 days.

## 7. Owner setup steps (to document in DEPLOY.md)

1. Cloudflare dashboard → R2 → create bucket (e.g. `flako-db`), note the Account ID.
2. R2 → Manage API tokens → create a token with **Object Read & Write**, limited to that bucket;
   copy the access key id and secret.
3. Render → service → Environment: add the four `R2_*` vars; Settings → Health check path `/healthz`.

## 8. Left to the builder

Exact Litestream version and config keys; script structure and log wording; how the client
enumerates "everything it knows" for the re-send (history vs. regenerating ops from the CRDT); the
MinIO test harness shape; docs wording. Update `CLAUDE.md` (deployment is Render + Cloudflare, not
Oracle) and `DEPLOY.md`, and add `LEARNING.md` entries (WAL streaming; fail-open startup; detecting a
rewound log with an op fingerprint).
