# Phase 2 — Live Collaboration Design

**Status:** draft for review · **Date:** 2026-10-17 · **Builds on:** `2026-10-16-phase1-foundation-design.md`

## 1. Intent

flako is a personal, end-to-end-encrypted notepad where the note's name is the key. Phase 2 lets
**a friend and me edit the same note at the same time and watch each other type live** — a
lightweight collaboration tool, not Google Docs. The owner re-learns Go and learns how
collaborative editors work by building one, so the CRDT is written from scratch (decided in
Phase 1 brainstorming) and every concept is taught as it is built.

**Success, in the owner's words:** two people typing in one note feels as smooth as typing
alone. "Laggy is unacceptable. Smoothness and feel is needed."

## 2. Goals

1. Two or more people with the same note open see each other's edits appear live; concurrent
   edits — even in the same line — merge without loss. The Phase 1 "changed somewhere else"
   conflict banner disappears for good.
2. **Anonymous presence:** each other person's cursor is shown (a caret or highlight in a colour),
   plus a count such as "3 here". No names, no list of who.
3. **Offline edits merge on reconnect.** If someone loses connection and keeps typing, their
   edits are kept (encrypted, locally) and merge in when they're back.
4. **Feel** (the top priority):
   - Local typing never waits for the network or for encryption.
   - Remote edits never move the local caret off the character it is on.
   - Remote cursors stay attached to the right character as text shifts.
   - Opening a note no longer freezes the page (~0.5 s today while Argon2 runs on the main thread).
5. Everything stays end-to-end encrypted: text edits **and** cursor positions. The server relays
   and stores ciphertext only.
6. The edit log is kept, so Phase 3 ("time machine" rewind) can be built on it later.

## 3. Non-goals (this phase)

- History / rewind UI (Phase 3). The log is kept; no UI.
- Names, avatars, chat, comments, rich text, formatting.
- Per-person permissions or identities. One link = full access (Phase 1 decision stands).
- Large groups. Target: a handful of people per note (design for ≤ 10; cap at 20 connections).
- Garbage-collecting CRDT tombstones. Deleted characters stay in the CRDT state forever this phase.
- Protecting against a malicious participant. Anyone who knows the name can already do anything.

## 4. Anti-goals — this phase fails, even if it "works", if:

- Typing feels laggy, stutters, or drops keystrokes, alone or together.
- The local caret jumps when someone else edits.
- The server can read note text or cursor positions, or learns note names.
- Anything someone typed is silently lost (online, offline, reconnecting, closing the tab).
- Using a note alone gets worse than Phase 1.

## 5. Constraints (carried from Phase 1)

- Go server (stdlib `net/http`, `modernc.org/sqlite`, embedded migrations), React + Vite client,
  single Docker image behind Caddy on an Oracle VPS. Must stay cheap: one small VM.
- Note URL is `/#/<name>`; the fragment never reaches the server. Note id = base64url of HKDF
  output (43 chars). The KDF (Argon2id → HKDF, `flako/v1` labels) is **frozen**; Phase 2 must not
  change derived ids or keys.
- AES-256-GCM, fresh random 12-byte IV per encryption, AAD includes the note id.
- localStorage may hold ciphertext only.
- Teaching: each task opens with a Concept note; `LEARNING.md` gains an entry per concept.
- Owner works on Windows; Go 1.24; the deploy is built from `master`.

## 6. Decided design

### 6.1 The CRDT: RGA, written from scratch

- Text is a sequence CRDT using **RGA (Replicated Growable Array)**.
- Every character has a unique, never-reused **id = (counter, replica)**:
  - `replica` is a random 64-bit id generated **per visit** (per tab load), so ids don't identify
    a person across sessions.
  - `counter` is a **Lamport clock**: one more than the largest counter this replica has seen.
- **Insert** = "put these characters after element X" (X may be the document start). Inserting a
  run of characters is one operation; the characters get consecutive counters.
- **Delete** = mark element ids as tombstones. Deleted characters stay in the structure (hidden),
  so concurrent inserts that reference them still land in the right place.
- **Tie-break:** when several elements are inserted after the same element, order by id
  descending (higher counter first, then higher replica). This makes every replica converge.
- **Required properties, enforced by tests:**
  - **Convergence:** applying the same set of ops in any order gives the same text.
  - **Idempotence:** applying an op twice is a no-op, keyed by element id. This is what makes
    resending after a lost ack, reconnects and offline replay safe.
- Run-length / block representation for long runs of text is left to the builder, but opening
  and typing in a note of ~100 KB of text must stay smooth (see §8).

### 6.2 Messages and encryption

- Local edits are applied to the local CRDT and textarea **immediately**. They are then collected
  into small batches (target ~50 ms, decided by the builder), encrypted, and sent.
- **Envelope:** each batch is encrypted with the note key (AES-GCM, fresh IV, AAD = note id plus a
  message-kind label, so a cursor message can't be replayed as an edit). The plaintext is a
  versioned JSON (or compact) payload; the exact encoding is left to the builder.
- **Presence** (cursor position + colour) is encrypted the same way, sent separately, relayed but
  **never stored**.
  - A cursor position is an element id (plus a selection end, if there is one), not an index, so
    it survives concurrent edits.
  - Colours are picked at random per visit from a fixed palette.
- **The viewer count** ("3 here", including yourself) comes from the server in plaintext. The
  server already knows how many connections a note has.

### 6.3 Server: a relay with a log

- **New endpoint:** WebSocket at `GET /api/notes/{id}/live`. It lives under `/api/`, so the SPA
  fallback and Caddy both handle it. Use **`github.com/coder/websocket`**; the standard library has
  no WebSocket support. This is the one new server dependency.
- A **room** per note id holds the connected clients. One goroutine per connection, plus a hub
  that fans messages out. A slow client must never block others: if its outgoing buffer fills, it
  is disconnected and reconnects.
- **Storage** (new migration, additive; the Phase 1 `notes` table stays):
  - `ops (note_id, seq, ciphertext, iv, created_at)`, primary key `(note_id, seq)`. The server
    assigns `seq` = 1, 2, 3… per note, inside a transaction, in arrival order. That order is the
    log. Correctness doesn't depend on it, because the CRDT converges in any order.
  - `snapshots (note_id, up_to_seq, ciphertext, iv, created_at)`, keeping at least the latest per
    note.
  - Ops are never deleted after a snapshot. They are Phase 3's history.
- **Snapshots are made by clients**, because the server can't read content.
  - When a connected client sees that more than ~500 ops have arrived since the latest snapshot,
    it uploads an encrypted snapshot of its full CRDT state (tombstones included) labelled with
    the `seq` it covers.
  - The server keeps it only if it is newer than the current one.
  - If several clients try at once, any one of them winning is fine.
- **Joining a note:**
  1. The client connects and says what it already has, if anything.
  2. The server replies with the latest snapshot, the ops after it, the current `seq`, and the
     viewer count.
  3. After that, every op is broadcast with its `seq`.
  4. The sender gets an ack for its own batch so it can clear its outbox.
- **Limits:** 20 connections per note; max frame ~256 KiB for op batches and ~4 MiB for
  snapshots. A whole note's text must still fit the spirit of the Phase 1 1 MiB limit. A ping or
  keepalive roughly every 30 s means idle connections behind Caddy and the Oracle network
  survive.
- **Server timeouts:** today's `http.Server` `ReadTimeout`/`WriteTimeout` (15 s) must not kill
  long-lived WebSocket connections, while still protecting the normal HTTP routes. A test must
  show a live connection surviving well past 15 s.
- **Logging:** the request logger keeps its Phase 1 rule (no page paths). Note ids in `/api/` paths
  are fine, as in Phase 1.

### 6.4 Offline and reconnect

- Outgoing encrypted batches wait in a **local outbox** (localStorage, `outbox:<id>`, ciphertext
  only) until acked. This replaces Phase 1's single `pending:<id>` slot.
- If the connection drops, typing continues normally against the local CRDT. The client
  reconnects with backoff (1 s doubling to 30 s, as in Phase 1, plus an immediate retry on the
  browser's `online` event). It catches up on missed ops and resends its unacked outbox.
  Idempotence makes duplicates harmless.
- The outbox must survive closing the tab. A batch counts as delivered only when the server acks
  it.
- **Known and accepted:** if two people rewrite the same sentence while disconnected from each
  other, the merge can read oddly (both versions interleaved). That's normal for this kind of
  tool; Phase 3's rewind is the safety net.

### 6.5 Moving Phase 1 notes over

- Phase 1 notes live as single encrypted blobs in `notes`. The first time a note with no ops or
  snapshot is opened, the client decrypts the blob and turns its text into the CRDT's starting
  state. It uses a **fixed, reserved import replica id with counters 1…n**. Two clients importing
  at the same moment therefore produce *identical* element ids, and idempotence de-duplicates
  them instead of doubling the text.
- After that, the legacy blob is read-only: `PUT /api/notes/{id}` returns **410 Gone**, so a
  stale Phase 1 client can't fork the note. `GET` stays, for importing.

### 6.6 The editor and "feel"

- Keep the plain `<textarea>`. Each input event is turned into CRDT inserts and deletes by
  diffing the previous and new value around the selection. Typing, paste, cut, delete-word and
  IME/composition input on mobile must all work.
- **Caret preservation:** before applying remote ops, convert the local selection (start/end) to
  CRDT element anchors; afterwards, convert back to indices and restore it. The caret and
  selection stay on the same characters.
- **Remote cursors** are drawn as an overlay aligned with the textarea's text. The technique
  (mirror element, canvas measurement…) is the builder's choice. They must follow scrolling and
  wrapping and move smoothly, not jump.
- **Argon2 moves to a Web Worker**, so the page stays responsive while a note opens. Derived ids
  and keys must be bit-for-bit identical; the Phase 1 known-answer tests still pass.
- A small, quiet connection indicator replaces Phase 1's save status (e.g. "live · 3 here",
  "offline — will sync"). The Phase 1 minimal UI stays; the owner likes it.

## 7. Security and privacy

- **The server sees:** note ids, connection count per note, op and snapshot sizes, and timing.
  Batching every ~50 ms still reveals **typing rhythm** (when someone is typing). This is
  accepted and documented in the README.
- **The server never sees:** names, text, cursor positions or colours.
- Everyone holding the name is equal, and any of them can corrupt the note (junk ops or
  snapshots). Accepted: same trust model as Phase 1.
- Replica ids are random per visit, so they don't link a person across sessions.

## 8. How we'll know it works

- **CRDT property tests:** random concurrent op sets applied in random orders and with duplicates
  converge to the same text, on every run.
- **Caret tests:** a remote insert or delete before, inside or after the local selection leaves
  it on the same characters.
- **Server integration tests over real WebSockets** (`httptest` server):
  - join and catch up (snapshot + ops);
  - broadcast to others plus ack to the sender;
  - viewer count on join and leave;
  - a slow client gets disconnected without stalling the room;
  - the connection limit;
  - the connection outlives the HTTP timeouts.
- **Offline test:** edits made while disconnected merge after reconnect; closing and reopening
  with an unacked outbox loses nothing.
- **Import test:** two clients importing the same Phase 1 note at once produce one copy of the
  text.
- **Two-browser manual check on the deployed app:** typing feels instant, cursors and the count
  show, there are no caret jumps, and nothing is lost through a reconnect.
- **Smoothness budget (for the builder to verify):**
  - keystroke-to-screen locally with no perceptible delay, including in a ~100 KB note;
  - remote edits visible within ~200 ms on a normal connection.
- **Privacy check:** a grep of the database for typed text and the note name finds nothing (as in
  Phase 1).

## 9. Teaching

Concepts to cover as they come up:

- CRDTs and convergence; RGA; Lamport clocks; idempotence and commutativity.
- WebSockets vs HTTP.
- Goroutines per connection, channels, `select`, fan-out hubs, back-pressure (dropping slow
  clients).
- `context` cancellation on disconnect; ping and keepalive; why server timeouts and long-lived
  connections clash.
- Web Workers.
- Diffing input into operations; anchors vs indices.

## 10. Left to the builder

- Wire encoding of messages; exact batching interval; message type names.
- CRDT internals (run-length blocks, indexing structures), as long as §8's smoothness budget holds.
- Remote-cursor rendering technique and palette.
- File layout, module boundaries, and the library version (pinned, compatible with Go 1.24).
- Whether the server de-duplicates resent batches, given that client idempotence already makes
  them harmless.
- How the client caches state between visits (optional; not required).
