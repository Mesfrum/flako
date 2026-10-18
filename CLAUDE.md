# flako

Personal, deliberately over-engineered, learning-focused E2EE notepad (shrib-style). Visit
`/#/<any-name>`: the name is the key (Argon2id → HKDF → AES-256-GCM in the browser); the server
stores only ciphertext under a hash of the name. Phase 2 adds live collaboration (own RGA CRDT
over WebSockets, remote cursors, offline merge).

## Branches
- `master` — deployed (Oracle VPS via Docker). **Never merge into it; the owner does cutovers.**
- `phase2-live` — current work (live collaboration). `archive/phase1` — preserved pre-live version.

## Commands
```bash
cd server && go run ./cmd/server          # API + WS on :8080, SQLite at server/data/notes.db
cd client && npm run dev                  # UI on :5173, proxies /api (incl. ws) to :8080
cd server && go test -count=1 ./...
cd client && npm test                     # vitest, node env
cd client && npx tsc -b && npm run lint
cd client && npm run build                # outputs into server/internal/web/dist (embedded in Go binary)
DOMAIN=localhost docker compose up -d --build   # full stack with Caddy HTTPS; see DEPLOY.md
```

## Layout
- `client/src/crypto/` — key derivation (runs in a Web Worker via `deriveInWorker.ts`), AES-GCM, base64url.
- `client/src/live/crdt/` — `rga.ts` (CRDT, chunked storage + id index), `undo.ts` (own-edits undo).
- `client/src/live/liveNote.ts` — sync engine (batching, outbox, catch-up, reconnect, presence, snapshots).
  `useLiveNote.ts` / `wsTransport.ts` wire it to React and WebSocket; `testing/fakeHub.ts` is the in-memory server for tests.
- `client/src/components/` — `LiveTextarea` (controlled textarea) + `RemoteCursors` (overlay).
- `server/internal/live/` — WebSocket hub (rooms, back-pressure, close codes). `store/` — notes + op log
  (memory and SQLite impls share contract tests; migrations in `store/migrations/`).
- `docs/superpowers/specs|plans/` — approved designs and implementation plans. `LEARNING.md` — learning log.

## Working rules
- **Teaching is mandatory:** explain each new concept in chat and add a `LEARNING.md` entry (correct
  entries that turn out wrong).
- TDD: failing test first; mutation-check important tests (break the code, confirm the test fails).
- Owner is token/time-conscious: ~5 repeat runs to check flakiness, not dozens; build first so the
  owner can test manually, then deepen tests.
- Keep hosting cheap (single binary + SQLite + Caddy).
- Plan execution ledger (git-ignored): `.superpowers/sdd/<plan-name>/progress.md` — check it before
  resuming plan work; tasks marked complete are done.

## Gotchas
- Crypto constants `flako/v1` (salt/HKDF info in `client/src/crypto/derive.ts`) are frozen: changing
  them silently orphans every existing note. Known-answer tests in `derive.test.ts` guard this.
- Hash routing (`/#/<name>`) is intentional — the note name must never reach the server. Server logs
  page paths as `[page]`.
- `statusRecorder.Unwrap()` in `server/internal/httpapi/middleware.go` is load-bearing: without it
  every WebSocket upgrade fails.
- Async tests: wait for a condition (op stored, outbox entry present), never a fixed number of
  ticks — every flaky test so far was a race of that kind.
- Windows dev box: long/backtick-heavy shell heredocs break; write files with the Write tool.
- Phase 1 PUT endpoint now returns 410; notes are written only through the live op log.
