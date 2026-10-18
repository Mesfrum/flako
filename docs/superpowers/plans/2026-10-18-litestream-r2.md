# Litestream → R2 and lost-history repair — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notes survive Render deploys via Litestream → Cloudflare R2, without backups ever being able
to take the app down; and open tabs detect a server that lost history and repair it.

**Architecture:** The server tells a reconnecting tab whether the op it last saw still exists
(IV fingerprint); if not, the tab re-syncs from zero and re-sends only what the server lacks,
generated from CRDT state. A POSIX `sh` entrypoint restores the DB from R2 (time-boxed,
integrity-checked, fail-open), runs the server as the main process and Litestream beside it.

**Tech Stack:** Go 1.24 hub, TypeScript engine (vitest), Litestream v0.5.x, Alpine, MinIO for
local S3 tests, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-18-litestream-r2-design.md` — read it first; this plan
argues from it.

## Global Constraints

- Branch `litestream-r2`. Never merge to `master` (owner does it).
- **Nothing backup-related may stop the server from starting or keep it down** (R2 down, wrong or
  missing keys, quota, slow/corrupt restore, Litestream crash). In every such case `/healthz` answers.
- No `R2_*` env vars → behaviour identical to today.
- Restore budget **≤ 20 s total including `PRAGMA integrity_check`**. Shutdown: server ≤ 10 s
  (existing), then Litestream final upload ≤ 15 s (Render kills at 30 s).
- Litestream: sync interval **10 s**, daily snapshot, retention ~**3 days**; binary pinned to a
  v0.5.x release and checksum-verified; container runs as non-root `app`.
- Env vars: `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. No secrets in
  repo or image. R2 endpoint `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, region `auto`.
- Wire: IVs are standard base64 (as today). Old clients (no `haveIv`) keep today's behaviour.
- Crypto constants `flako/v1` untouched. TDD; mutation-check key tests; ~5 repeat runs max.
- Async tests wait for a condition, never a fixed number of ticks.
- Every task adds its concepts to `LEARNING.md` and explains them in chat.

## Review Focus

1. **Tab with unsent outbox items when a reset happens** → those edits still arrive exactly once in
   the text (duplicates are harmless in the CRDT, but nothing may vanish). → test in Task 3.
2. **Reset while IME composition holds remote ops** → held ops are applied when composition ends;
   repair waits until then. → test in Task 3.
3. **Repair of a note near the 1 MiB limit** → re-sent ops go out split under the frame limit,
   no "note is full" for a tab that already showed the text. → test in Task 3.
4. **SIGTERM timing** → server exits, Litestream gets its final upload, whole container exits in
   < 30 s even when R2 is unreachable. → scenario in Task 4.
5. **Restored DB left with stale `-wal`/`-shm` siblings or a half-written temp file from a killed
   previous boot** → never opened as the live DB. → scenario in Task 4.

---

### Task 1: Server — detect a rewound log on hello

**Files:**
- Modify: `server/internal/live/messages.go`, `server/internal/live/hub.go` (`catchUp`)
- Test: `server/internal/live/hub_test.go`

**Interfaces:**
- Produces (wire, mirrored in Task 3):
  - `inMsg.HaveIV string \`json:"haveIv"\`` (hello only; may be empty).
  - `welcomeMsg.Reset bool \`json:"reset"\`` and `welcomeMsg.SeqIV string \`json:"seqIv"\``
    (IV of the server's op at `welcome.seq`; `""` when seq is 0).
- Rule in `catchUp`: if `have > 0 && haveIv != ""`, fetch the op at `have` via
  `OpsAfter(ctx, id, have-1, 1)`. If missing, or its seq ≠ `have`, or its IV ≠ `haveIv` → `Reset:
  true` and catch up exactly as for `have == 0` (snapshot path). No store changes.

- [ ] **Step 1: Write failing tests** (use existing hub test helpers):
  - `TestHelloWithMatchingIVCatchesUpNormally`: append 3 ops; hello `{have:2, haveIv:<iv of op 2>}`
    → welcome `reset:false`, `seqIv == <iv of op 3>`, then op 3 only, then synced 3.
  - `TestHelloAheadOfServerResets`: append 2 ops; hello `{have:5, haveIv:"x"}` → `reset:true`,
    then ops 1–2, synced 2.
  - `TestHelloWithDifferentIVResets`: append 6 ops; hello `{have:4, haveIv:<not op 4's iv>}` →
    `reset:true`, ops 1–6 (or snapshot + ops after it if one exists).
  - `TestHelloWithoutIVKeepsOldBehaviour`: append 2 ops; hello `{have:5}` → `reset:false`, no ops.
  - `TestWelcomeSeqIVEmptyForEmptyNote`.
- [ ] **Step 2:** `cd server && go test -count=1 -run 'Hello|SeqIV' ./internal/live/` → FAIL.
- [ ] **Step 3:** Implement the fields and the rule above.
- [ ] **Step 4:** Same command → PASS; then `go vet ./... && go test -count=1 ./...` → PASS.
- [ ] **Step 5: Mutation check:** compare only seq (ignore IV) → `DifferentIV` test must fail;
  restore.
- [ ] **Step 6:** LEARNING entry "Detecting a rewound log with an op fingerprint". Commit
  `feat(server): tell a reconnecting tab when the op log was rewound`.

### Task 2: CRDT — state to ops

**Files:**
- Modify: `client/src/live/crdt/rga.ts`
- Test: `client/src/live/crdt/rga.test.ts`

**Interfaces:**
- Produces: `export function opsFromState(state: RgaState): Op[]` — ops that, applied to any
  replica whose ops are a causally-closed subset of the state's, make it equal to the state.
  Inserts in document order (runs, `after` = preceding element in document order *including
  tombstones*, `null` at the start); then `del`/`undel` ops carrying each run's stamp.
- Consumes: existing `Rga`, `RgaState`, `Op`, `Rga.has` / `Rga.apply` / `Rga.toState`.

- [ ] **Step 1: Write failing tests:**
  - `opsFromState rebuilds a fresh replica`: random edits by 3 replicas → `full`; a fresh `Rga`
    applying `opsFromState(full.toState())` has `text()` and `toState()` equal to `full`'s.
  - `opsFromState completes any prefix replica` (property, ≥ 200 seeds, reuse the existing property
    harness): ops log L from 3 replicas with concurrent inserts/deletes/undeletes; for a random
    prefix length k, replica R applies `L[0..k)` then `opsFromState(full.toState())` → `R.text() ===
    full.text()` and states equal. Include a 3000-char prefill seed (crosses chunk boundaries).
  - `opsFromState is a no-op on the same replica`: applying to `full` changes nothing.
- [ ] **Step 2:** `cd client && npx vitest run src/live/crdt/rga.test.ts` → FAIL.
- [ ] **Step 3:** Implement. If the prefix property fails for predecessor-anchored inserts, stop and
  report the counterexample (it changes Task 3's design) — don't weaken the test.
- [ ] **Step 4:** PASS; mutation check: anchor each run to the previous *visible* char instead of
  the previous element → property must fail; restore.
- [ ] **Step 5:** LEARNING entry "Turning CRDT state back into ops". Commit
  `feat(client): rebuild CRDT ops from a state`.

### Task 3: Engine — remember the IV at `have`, repair on reset

**Files:**
- Modify: `client/src/live/protocol.ts`, `client/src/live/liveNote.ts`,
  `client/src/live/testing/fakeHub.ts`
- Test: `client/src/live/liveNote.test.ts`

**Interfaces:**
- Consumes: Task 1 wire fields; Task 2 `opsFromState`.
- Produces: `ClientMsg` hello `{ t: "hello"; have: number; haveIv?: string }`; welcome gains
  `reset: boolean; seqIv: string`. FakeHub mirrors Task 1's rule exactly and gains
  `rewind(toSeq: number): void` (drops log entries and snapshots above `toSeq`, then `dropAll()`).
- Engine rules:
  - Track the IV of the op at `have`: from `op` messages, from the sealed IV of its own batch on
    `ack` (look it up by cid before removing from the outbox), and from `welcome.seqIv` at
    `welcome.seq`. Keep IVs only for `have` and seqs in `above`; send it as `haveIv` when `have > 0`.
  - On `welcome.reset`: clear `have`, `above`, stored IVs, `lastSnapshotUpTo`; do **not** re-base
    the visible CRDT onto the server snapshot (that would drop text). Instead build `server = new
    Rga(...)` from the welcome snapshot and every op that follows until `synced`, applying each to
    both `server` and the visible CRDT (the visible text gains only what's new). On `synced`:
    `missing = opsFromState(this.rga.toState()).filter(op => !server-has-it)` → `queued`, `flush()`
    (existing batch splitting). Then normal outbox replay. No snapshot upload while repairing.
  - "server-has-it": an `ins` whose every char id `server.has`; a `del`/`undel` whose stamp is
    already the latest on all its ranges in `server`. (Builder may simplify to a cheaper exact rule
    if the tests below still pass.)

- [ ] **Step 1: Write failing tests** (FakeHub, two engines A and B; wait on conditions):
  - `rewound server: tab ahead re-sends lost edits` — A types "hello", acked (seq 1..n); `hub.rewind(0)`;
    A reconnects → hello carries `haveIv`, welcome `reset`, A's text unchanged throughout, hub log
    regains it; new tab C opening the note sees "hello".
  - `rewound then advanced: no skipped ops` — A at have=4; `rewind(2)`; B (fresh) pushes 3 new
    batches (seqs 3–5, different ops); A reconnects → reset; A ends with B's edits + its own; A, B
    and newcomer C converge.
  - `healthy reconnect sends haveIv and gets no reset` — plain drop/reconnect; welcome `reset:false`;
    no extra ops appended to the hub log.
  - `two tabs repairing at once converge` — A and B both ahead; `rewind(0)`; both reconnect →
    identical text everywhere; hub log grows by at most 2× the note's ops.
  - Review Focus 1: A has unsent outbox items (hub `holdAcks`) when `rewind` happens → after repair,
    every outbox edit appears exactly once in the text.
  - Review Focus 2: reset arrives while A is composing → no text change until composition ends,
    then converges.
  - Review Focus 3: A holds ~900 KiB, `rewind(0)`, reconnect → repair frames each ≤ the existing
    batch limit; `full` stays false; C converges.
- [ ] **Step 2:** `cd client && npx vitest run src/live` → new tests FAIL.
- [ ] **Step 3:** Implement protocol, FakeHub, engine rules.
- [ ] **Step 4:** PASS; full `npx vitest run && npx tsc -b && npm run lint` PASS; run the new tests
  5× (`--repeat` or loop) → all green.
- [ ] **Step 5: Mutation checks:** (a) send no `haveIv` → "rewound then advanced" fails; (b) re-base
  onto the server snapshot on reset → "tab ahead" fails (text lost); restore.
- [ ] **Step 6:** LEARNING entry "Repairing after a server lost history". Commit
  `fix(client): detect a rewound server and re-send what it lost`.

### Task 4: Image — Litestream, fail-open entrypoint, local S3 harness

**Files:**
- Create: `docker/entrypoint.sh`, `docker/litestream.yml`, `docker/test/compose.minio.yaml`,
  `docker/test/backup-scenarios.sh`
- Modify: `Dockerfile` (runtime stage: `sqlite` apk, pinned Litestream binary + sha256 check,
  copy script/config, `ENTRYPOINT ["/app/entrypoint.sh"]`), `compose.yaml` only if needed to pass
  the `R2_*` vars through (empty by default).

**Interfaces:**
- `entrypoint.sh` behaviour (spec §4): all four `R2_*` set → restore to a temp path with `timeout`,
  `-if-replica-exists`, `integrity_check` = `ok` → move into `DB_PATH` (remove any stale `-wal`/`-shm`
  first); otherwise log one clear line and continue empty. Start `flako-server` in the background;
  once it listens, start `litestream replicate -config /app/litestream.yml` in the background (its
  failure is logged, never fatal). Trap TERM/INT: TERM the server, wait; TERM Litestream, wait ≤ 15 s;
  exit with the server's code. If the server exits on its own, stop Litestream and exit with its code.
- `litestream.yml`: one DB at `${DB_PATH}`, S3 replica to `${R2_BUCKET}` path `flako/notes.db`,
  endpoint/keys from the env vars; 10 s sync; daily snapshot; ~72 h retention — verify each key
  against the pinned version's docs and note them in a comment.
- The harness points the same image at MinIO (`R2_ACCOUNT_ID` replaced by an override endpoint —
  add an optional `LITESTREAM_ENDPOINT` env that, when set, is used instead of the R2 endpoint;
  document it as test-only).

- [ ] **Step 1: Write `backup-scenarios.sh` first** (each scenario: bring up, assert, tear down;
  prints PASS/FAIL per scenario; asserts with `curl -fsS http://127.0.0.1:8080/healthz` within 30 s):
  1. no `R2_*` vars → healthy, logs "backups off";
  2. MinIO up, empty bucket → healthy; write a note (append an op via a tiny Go/JS client or the
     existing Playwright driver), wait 12 s, recreate the container → the note's op count survives;
  3. wrong keys → healthy;
  4. endpoint unreachable → healthy within 30 s;
  5. restore hangs (MinIO paused) → healthy within 30 s, empty DB;
  6. corrupt backup (overwrite replica objects with junk) → healthy, empty DB;
  7. `kill -9` Litestream inside the container → `/healthz` still answers;
  8. `docker stop -t 30` with MinIO unreachable → container exits in < 30 s; with MinIO up → the
     last write before stop is restored on next boot.
- [ ] **Step 2:** Run it against the current image → scenarios 2 and 8b FAIL (no backups yet).
- [ ] **Step 3:** Implement Dockerfile, script, config.
- [ ] **Step 4:** `sh docker/test/backup-scenarios.sh` → all PASS; run twice more.
- [ ] **Step 5: Mutation check:** make the restore failure `exit 1` → scenarios 3–6 FAIL; restore.
- [ ] **Step 6:** LEARNING entries "Litestream: streaming the WAL" and "Fail-open startup". Commit
  `feat(deploy): Litestream backups to R2 with a fail-open entrypoint`.

### Task 5: Two writers (deploy overlap) — test, gated fallback

**Files:** extend `docker/test/backup-scenarios.sh` (scenario 9); fallback only if needed:
`docker/entrypoint.sh`, `docker/litestream.yml`.

- [ ] **Step 1:** Scenario 9: container A running and writing; start container B (same bucket/path)
  → B restores and starts writing; keep both writing 30 s; stop A (TERM); then a third container C
  restores. Assert: C is healthy and its DB passes `integrity_check`; record whether C has A's last
  writes and B's writes.
- [ ] **Step 2:** Run 3×. **If C is always healthy with an intact DB:** record the result in the
  spec's §3 ("verified") and LEARNING; done — no fallback.
- [ ] **Step 3 (only if Step 2 shows a failed or corrupt restore):** per-boot replica path
  `flako/<boot UTC timestamp>/notes.db`; restore picks the newest prefix (list via `litestream ltx`
  or an S3 list — needs list permission on the token, document it); note in DEPLOY.md that an R2
  lifecycle rule deletes objects older than 7 days. Re-run scenarios 1–9.
- [ ] **Step 4:** Commit `test(deploy): verify overlapping deploys` (+ `feat` if the fallback was
  built).

### Task 6: Docs and final verification

**Files:** `DEPLOY.md` (Render + Cloudflare + R2 steps from spec §7, env vars, health check path,
how to turn backups off, how to restore manually), `CLAUDE.md` (deploy target is Render free +
Cloudflare at flako.in, UptimeRobot; backups via Litestream → R2; add `docker/test/backup-scenarios.sh`
to Commands), `README.md` (one line: notes are backed up to R2 as ciphertext).

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** Full suites: `cd server && go vet ./... && go test -count=1 ./...` and
  `cd client && npx vitest run && npx tsc -b && npm run lint`; `sh docker/test/backup-scenarios.sh`.
  All PASS.
- [ ] **Step 3:** Two-tab check with the scratchpad Playwright driver against the MinIO-backed
  stack: open a note in two tabs, recreate the app container, both tabs return to `live · 2 here`
  with identical text and nothing lost.
- [ ] **Step 4:** Commit `docs: Render + R2 deployment and backups`. Stop — the owner creates the R2
  bucket/token, sets Render env vars, merges, and checks a note survives a real deploy.
