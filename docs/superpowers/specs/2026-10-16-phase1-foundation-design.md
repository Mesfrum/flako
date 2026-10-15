# Phase 1 — Foundation: E2E-Encrypted Named Notes

Date: 2026-10-16
Status: Approved design, pending spec review

## 1. Context & Intent

shribe2e is a shrib.com-style notepad: visit `/<any-name>` and a note exists there.
The original 2025 prototype (React + Go + Supabase) stored notes in plaintext and
never implemented the planned encryption. This rebuild is:

- **For personal use and amusement.** A portfolio piece is a bonus, not a goal.
- **A learning project.** The author is re-learning Go; every step is taught.
  Deliberate over-engineering is welcome when it teaches something.
- **Deployed cheaply to the cloud** for personal use (Phase 5).
- **Visually "uncanny brutalist"** (Phase 4): clear structure, but colors and
  details are subtly off — understandable, yet not natural.

### Roadmap (each phase gets its own spec → plan → build cycle)

| Phase | Name | Summary |
|---|---|---|
| **1** | **Foundation** (this spec) | SQLite, clean Go server, name-derived E2E encryption, autosave, optimistic concurrency |
| 2 | Own CRDT + live collab | Hand-written RGA-style text CRDT in TypeScript; Go WebSocket rooms relaying encrypted ops; append-only encrypted op log |
| 3 | Time machine | Encrypted snapshots every ~500 ops; replay; history scrub slider |
| 4 | Uncanny UI + name | Full visual identity; pick the 3-syllable project name |
| 5 | Deploy | Docker image, single small VM, Litestream → object storage, HTTPS |

Architecture decision for the whole project: **everything is an encrypted
operation** (event-sourcing style). Phase 1 stores whole-note encrypted blobs;
Phase 2 introduces the op log, and the Phase 1 blob becomes the first snapshot form.

### Decisions already made

- One link = full read/write access. No accounts, no separate read-only links.
- User-chosen note names (shrib-style). **The name is the secret**: the
  encryption key is derived from it. Weak names are weak notes — by design,
  surfaced in the UI.
- Database: **SQLite** (local file now, Litestream-replicated in prod), behind a
  Go `Store` interface so Postgres remains a one-file swap.
- No CORS: Vite proxies `/api` in dev; in prod the Go binary embeds and serves
  the built client (single origin, single binary).

## 2. Scope

**In scope**
- Repo restructure (server and client) as laid out below
- SQLite store with embedded SQL migrations
- `GET` / `PUT` note API with optimistic concurrency
- Browser-side Argon2id + HKDF key derivation and AES-GCM encryption
- Debounced autosave, conflict handling, offline retry of encrypted pending saves
- Home page: name input + strong random name generator + strength hint
- Tests (Go unit + integration, Vitest for crypto)
- `LEARNING.md` concept log

**Out of scope (later phases)**
WebSockets, CRDT, live collaboration, history, final visual design, project
name, deployment, Docker.

## 3. Layout

```
shribe2e/
├── LEARNING.md
├── docs/superpowers/specs/
├── server/
│   ├── cmd/server/main.go        # wiring only: config → store → router → serve
│   ├── internal/
│   │   ├── config/               # env → typed Config struct
│   │   ├── store/
│   │   │   ├── store.go          # Store interface, Note type, sentinel errors
│   │   │   ├── sqlite.go         # SQLite implementation
│   │   │   ├── memory.go         # in-memory fake (tests)
│   │   │   └── migrations/*.sql  # embedded via //go:embed
│   │   ├── httpapi/              # handlers, middleware, JSON helpers
│   │   └── web/                  # embeds client/dist for prod serving
│   ├── .air.toml
│   └── .env.example
└── client/src/
    ├── crypto/                   # derive.ts, cipher.ts — pure, tested
    ├── notes/                    # api.ts, useNote.ts (autosave, conflicts, retry)
    ├── names/                    # normalize, random name generator, strength
    └── pages/                    # Home, Note
```

Removed: `gorilla/mux`, `pgx`, `godotenv` (config defaults work locally with no `.env`;
`.env.example` documents overrides), `axios`, dead hooks (`useAutoSaveNote`, old `useNote`),
Supabase-specific code, the empty Footer.

## 4. Server

### 4.1 Storage

Driver: `modernc.org/sqlite` (pure Go, no CGO — avoids Windows toolchain pain).
On open: `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;`.

Migrations: numbered `.sql` files embedded with `//go:embed`, applied in order at
startup by a small hand-written migrator tracking applied versions in a
`schema_migrations` table (written by hand for learning; ~50 lines).

```sql
-- 001_notes.sql
CREATE TABLE notes (
  id          TEXT PRIMARY KEY,   -- base64url(HKDF(master,"id")), 43 chars
  ciphertext  BLOB NOT NULL,
  iv          BLOB NOT NULL,      -- 12 bytes
  version     INTEGER NOT NULL,   -- starts at 1 on first save
  created_at  INTEGER NOT NULL,   -- unix ms
  updated_at  INTEGER NOT NULL    -- unix ms
);
```

### 4.2 Store interface

```go
var (
    ErrNotFound        = errors.New("note not found")
    ErrVersionConflict = errors.New("version conflict")
)

type Note struct {
    ID         string
    Ciphertext []byte
    IV         []byte
    Version    int64
    CreatedAt  time.Time
    UpdatedAt  time.Time
}

type Store interface {
    GetNote(ctx context.Context, id string) (Note, error)
    // PutNote creates (baseVersion == 0) or updates (baseVersion == current).
    // Returns the stored note with its new version, or ErrVersionConflict
    // together with the current version.
    PutNote(ctx context.Context, n Note, baseVersion int64) (Note, error)
}
```

Conflict semantics, done atomically in one statement/transaction:
- `baseVersion == 0` and row absent → insert with version 1.
- `baseVersion == 0` and row present → conflict.
- `baseVersion == current` → update, version = current + 1.
- otherwise → conflict.

`ErrVersionConflict` is returned wrapped in a `*ConflictError{Current int64}`
that satisfies `errors.Is(err, ErrVersionConflict)` (teaches custom error types
+ `Unwrap`).

### 4.3 HTTP API

All JSON. Binary fields are base64 (standard encoding) strings.

| Method & path | Request body | Responses |
|---|---|---|
| `GET /api/notes/{id}` | — | `200 {ciphertext, iv, version, updated_at}` · `404 {error}` · `400` bad id |
| `PUT /api/notes/{id}` | `{ciphertext, iv, base_version}` | `200 {version, updated_at}` · `409 {error, current_version}` · `400` · `413` |
| `GET /healthz` | — | `200 ok` |
| `GET /*` (prod) | — | embedded SPA; unknown paths fall back to `index.html` |

Validation:
- `id` must match `^[A-Za-z0-9_-]{43}$`.
- `iv` must decode to exactly 12 bytes.
- `ciphertext` must decode and be ≥ 16 bytes (GCM tag). An empty note is a
  valid encryption of `{"v":1,"text":""}`, so empty notes save fine.
- Body capped at 1 MiB via `http.MaxBytesReader` → `413`.

Routing: standard library `http.ServeMux` with Go 1.22+ method/wildcard patterns.

### 4.4 Middleware & lifecycle

- Request logging via `log/slog` (method, path, status, duration). Note IDs are
  logged; nothing else about content exists to log.
- Panic recovery → `500` + log with stack.
- Config from env: `ADDR` (default `:8080`), `DB_PATH` (default `./data/notes.db`).
- Graceful shutdown: `signal.NotifyContext` + `http.Server.Shutdown` with a 10s
  timeout; DB closed after the server drains.
- Server timeouts set (`ReadHeaderTimeout` etc.) — taught as a gotcha.

## 5. Client

### 5.1 Name handling

- Name = URL path segment after decoding, `trim()` + `toLowerCase()` + NFC
  normalize. `/Taco` and `/taco` are the same note.
- Empty name → Home page.
- Random generator: 4 words from a bundled wordlist (≈ 2048 words → 44 bits)
  joined by `-`, using `crypto.getRandomValues`.
- Strength hint: rough entropy estimate (length/charset, and a bonus when the
  name matches the generator's shape). Displayed as a plain sentence. Wording
  is a Phase 4 concern; Phase 1 ships functional text.

### 5.2 Key derivation (`crypto/derive.ts`)

```
master = Argon2id(password = name, salt = "shribe2e/v1",
                  memory = 64 MiB, iterations = 3, parallelism = 1, length = 32)
id     = base64url(HKDF-SHA256(master, salt = empty, info = "shribe2e/v1/id",  32 bytes))
encKey = HKDF-SHA256(master, salt = empty, info = "shribe2e/v1/enc") → AES-GCM-256 CryptoKey, non-extractable
```

- Argon2id via `hash-wasm`; HKDF and AES via WebCrypto (`crypto.subtle`).
- Running the derivation off the main thread (Web Worker) is **not** required in Phase 1 (one
  ~0.5–1s call with a visible "deriving" state is acceptable).
- Known, accepted limitation: the app-wide fixed salt permits one dictionary
  attack against all notes. Mitigated only by Argon2 cost and strong names.
  The `v1` tag allows a future migration.

### 5.3 Encryption (`crypto/cipher.ts`)

- Plaintext: UTF-8 JSON `{"v":1,"text":"..."}`.
- AES-256-GCM, fresh 12-byte random IV per encryption.
- Additional authenticated data: UTF-8 bytes of the note `id`. A blob moved
  to another note's row will fail authentication.
- `decrypt` throws a typed `DecryptError` on any failure.

### 5.4 Note lifecycle (`notes/useNote.ts`)

States: `deriving → loading → ready | unreadable | error`.

1. Derive `{id, encKey}` from the name.
2. `GET /api/notes/{id}`:
   - `404` → empty text, `version = 0`.
   - `200` → decrypt; on `DecryptError` → `unreadable` (read-only, saving disabled).
3. On edit: debounce 1000 ms → encrypt → `PUT` with `base_version = version`.
   Only one PUT in flight at a time; edits during a flight queue one follow-up
   save with the newest text.
4. `200` → update `version`, status "saved at …".
5. `409` → stop autosaving; show conflict choice:
   - *Load theirs*: refetch, decrypt, replace local text.
   - *Keep mine*: refetch to learn current version, re-PUT local text on it.
6. Network error / `5xx` → store `{id, ciphertext, iv, base_version}` in
   `localStorage["pending:<id>"]` (ciphertext only, never plaintext); retry with
   exponential backoff (1s, 2s, 4s … max 30s) and on `online` event. Status
   "unsaved". On next load, if a pending entry exists, attempt it first (a
   resulting `409` goes through the conflict flow).
7. `413` → status "too large", keep local text, stop autosave until text shrinks.

Data fetching uses plain `fetch` wrapped in `notes/api.ts`. TanStack Query is
removed (Phase 2 moves sync to WebSockets; it would not earn its keep).

### 5.5 Pages

- **Home**: name input → navigate to `/<name>`; "generate one" button; strength hint.
- **Note**: status line, textarea, conflict/unreadable banners.
- Styling: minimal, plain. Phase 4 owns the visual design.

## 6. Error Handling Summary

| Situation | Behaviour |
|---|---|
| Decrypt fails | `unreadable` state; never overwrites; saving disabled |
| 409 | Conflict choice (load theirs / keep mine) |
| Network / 5xx | Encrypted pending save in localStorage; backoff retry; "unsaved" |
| 413 | "too large"; local text kept |
| Handler panic | Recovered → 500, logged, server continues |
| Store errors | Wrapped with `%w` and context; logged; client gets generic 500 |

## 7. Testing

- **Go, unit:** table-driven handler tests using `httptest` and the in-memory
  `Store`: valid get/put, 404, bad id, bad iv length, oversized body, conflicts.
- **Go, integration:** SQLite store against a temp-dir DB file: migrations
  apply idempotently; create/update/conflict semantics; **concurrent race test**
  — N goroutines PUT on the same `base_version`, exactly one succeeds
  (`sync.WaitGroup`).
- **Client (Vitest):** encrypt/decrypt round-trip; deterministic derivation for
  the same name; different names → different id and key; tampered ciphertext,
  IV, or AAD/id → `DecryptError`; name normalization; generator output shape.
- **Manual:** two tabs on one note → conflict flow; kill server mid-typing →
  "unsaved" → restart → saved; reload shows decrypted text.
- Development follows TDD.

## 8. Teaching Approach

- Each implementation-plan task opens with a short **Concept** note before code.
- `LEARNING.md` accumulates one entry per concept (Go and crypto), written for
  a reader returning after a long break.
- Gotchas are called out when met: IV reuse in GCM, nil-interface values,
  loop-variable capture in goroutines, missing server timeouts, `defer` in loops.

Concepts expected in Phase 1: modules & `internal/`, `context`, sentinel and
custom errors (`errors.Is/As`, `%w`, `Unwrap`), implicit interfaces, `defer`,
`//go:embed`, `net/http` 1.22 routing, middleware as `func(http.Handler) http.Handler`,
`log/slog`, `signal.NotifyContext`, table-driven tests, goroutines + `WaitGroup`,
Argon2id vs fast hashes, HKDF, AES-GCM + IV + AAD.

## 9. Success Criteria

- `go run ./cmd/server` + `npm run dev` gives a working app with no Docker and
  no external services.
- Visiting `/<name>` and typing persists across reloads and server restarts.
- The SQLite file contains no plaintext and no note names.
- Two tabs editing one note never silently lose data.
- All tests pass; `LEARNING.md` covers every concept listed in §8.
