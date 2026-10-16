# shribe2e

A shrib-style notepad: go to `/#/<any-name>` and start typing. The name is the key — notes are
encrypted in your browser (Argon2id → HKDF → AES-256-GCM) and the server only ever stores
ciphertext under a hash of the name. Personal project; see `LEARNING.md` for everything it teaches
and `docs/superpowers/specs/` for the design.

## Develop

Requires Go 1.24+ and Node 20+.

```bash
cd server && go run ./cmd/server     # API on :8080, SQLite at server/data/notes.db
cd client && npm install && npm run dev   # UI on :5173, proxies /api to :8080
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
cd server && go build -o shribe2e ./cmd/server
./shribe2e                            # UI + API on :8080
```

Env vars (optional): `ADDR` (default `:8080`), `DB_PATH` (default `./data/notes.db`).

## Security model, honestly

- Anyone who knows (or guesses) a note's name can read and edit it. Short names are weak.
- The salt is app-wide by necessity, so one dictionary attack covers every note. Argon2id makes each guess cost ~0.5s and 64 MB.
- The server sees: note-id hashes, ciphertext sizes, and timing. Never names or text.
