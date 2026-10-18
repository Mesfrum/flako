# flako

A shrib-style notepad: go to `/#/<any-name>` and start typing. The name is the key — notes are
encrypted in your browser (Argon2id → HKDF → AES-256-GCM) and the server only ever stores
ciphertext under a hash of the name. Personal project; see `LEARNING.md` for everything it teaches
and `docs/superpowers/specs/` for the design.

## Develop

Requires Go 1.24+ and Node 20+.

```bash
cd server && go run ./cmd/server     # API on :8080, SQLite at server/data/notes.db
cd client && npm install && npm run dev   # UI on :5173, proxies /api (incl. WebSocket) to :8080
```

Hot reload for Go: `cd server && air`. Both at once: `cd client && npm run dev:full`.

## Test

```bash
cd server && go test ./...
cd client && npm test
```

## Build one binary

```bash
cd client && npm run build            # writes into server/internal/web/dist
cd server && go build -o flako ./cmd/server
./flako                            # UI + API on :8080
```

Env vars (optional): `ADDR` (default `:8080`), `DB_PATH` (default `./data/notes.db`).

In the Docker image, notes are continuously backed up to Cloudflare R2 as ciphertext (Litestream; set the four `R2_*` vars, see `DEPLOY.md`).

## Security model, honestly

- Anyone who knows (or guesses) a note's name can read and edit it. Short names are weak.
- The salt is app-wide by necessity, so one dictionary attack covers every note. Argon2id makes each guess cost ~0.5s and 64 MB.
- The server sees: note-id hashes, ciphertext sizes (edit batches and snapshots), and timing. Never names or text.
- Live mode adds metadata: the server can tell **when someone is typing** (edit batches go out about every 50 ms, so typing rhythm and batch size show) and **how many people are connected** to a note. Cursor positions and colours are encrypted like the text, so it never sees those, but it does see that presence messages are flowing.
- Anyone holding the name is an equal peer and can corrupt the note (junk edits or snapshots). That is the same trust model as before.
- Deleted characters stay in the stored CRDT state (tombstones) until garbage collection exists, so history is not truly erased from the encrypted log.

## Collaborating

Share the `/#/<name>` link. Anyone with it can read and edit, live, and sees the others' cursors and
selections. The status line shows `live · N here`. Edits made offline are kept and sync (merged, not
overwritten) when you reconnect. Ctrl+Z undoes only your own edits, never someone else's. Notes are
limited to 1 MiB of visible text.
