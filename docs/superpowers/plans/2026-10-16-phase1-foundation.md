# Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild flako so that visiting `/<name>` opens an end-to-end encrypted note, derived from the name, autosaved to a SQLite-backed Go server that never sees plaintext or names.

**Architecture:** Go server (stdlib `net/http`, `modernc.org/sqlite`, hand-written embedded migrations) exposes `GET/PUT /api/notes/{id}` with optimistic concurrency behind a `store.Store` interface. The React client derives `{id, AES key}` from the note name (Argon2id → HKDF), encrypts with AES-GCM (note id as AAD), and runs a framework-agnostic `NoteSync` state machine (debounce, in-flight queueing, conflicts, offline retry with ciphertext-only pending saves) wrapped by a React hook. In prod the Go binary embeds the built client.

**Tech Stack:** Go 1.24, `modernc.org/sqlite` v1.38.2, `log/slog`; React 18, Vite 6, TypeScript 5.7, Tailwind 4, `hash-wasm` 4.12, Vitest 3.

**Spec:** `docs/superpowers/specs/2026-10-16-phase1-foundation-design.md`

## Global Constraints

- Go module path stays `github.com/Mesfrum/flako/server`; `go` directive `1.24`. Pin `modernc.org/sqlite@v1.38.2` (newer versions require Go 1.26).
- No CGO, no Docker, no external services in Phase 1.
- Server never receives the note name or plaintext. Only `id` (43-char base64url), `ciphertext`, `iv`.
- Note id regex: `^[A-Za-z0-9_-]{43}$`. IV exactly 12 bytes. Ciphertext ≥ 16 bytes. Body ≤ 1 MiB (`1 << 20`).
- KDF is frozen: Argon2id(salt `"flako/v1"`, memory 65536 KiB, iterations 3, parallelism 1, length 32) → HKDF-SHA256 (empty salt) with info `"flako/v1/id"` and `"flako/v1/enc"`.
- Plaintext format: UTF-8 JSON `{"v":1,"text":"..."}`. AES-256-GCM, fresh random 12-byte IV per encryption, AAD = UTF-8 note id.
- `localStorage` may only ever hold ciphertext (key `pending:<id>`), never plaintext.
- Debounce 1000 ms; retry backoff 1s doubling to max 30s.
- Timestamps on the wire: unix milliseconds. Binary on the wire: standard base64.
- Styling stays minimal; no new UI libraries (Phase 4 owns design).
- Every commit message ends with the trailer line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Teaching:** each task opens with a **Concept** note and appends its entry to `LEARNING.md`. The human is re-learning Go — when executing, explain the Concept note to them in chat before writing the code.

## Review Focus

- **Odd note names** (`/Café`, `/Café`, `/  Taco `, names with `/` or spaces): must map to one canonical note with no redirect loops → normalization tests in Task 6, redirect logic in Task 10.
- **Deleting all text** must save (an encrypted empty note is still ≥ 16 bytes) → server test in Task 4, `NoteSync` test in Task 9.
- **Typing while a save is in flight** must not drop the newer keystrokes → `NoteSync` test in Task 9.
- **Reload with a stale pending save** (written against an old version) must surface a conflict, never silently overwrite → `NoteSync` test in Task 9.
- **Unknown `/api/...` paths** must return JSON 404, not the SPA's HTML → API test in Task 4; SPA fallback tests in Task 11.

---

## File Map

**Server (`server/`)**
| File | Responsibility |
|---|---|
| `cmd/server/main.go` | Wiring: config → store → routes → middleware → serve; graceful shutdown |
| `internal/config/config.go` | Env → `Config{Addr, DBPath}` with defaults |
| `internal/store/store.go` | `Store` interface, `Note`, `ErrNotFound`, `ErrVersionConflict`, `ConflictError`, `nowMilli` |
| `internal/store/memory.go` | Mutex+map `Store` (tests, reference semantics) |
| `internal/store/sqlite.go` | SQLite `Store`, `OpenSQLite`, `openDB` |
| `internal/store/migrate.go` | Embedded-migration runner |
| `internal/store/migrations/001_notes.sql` | `notes` table |
| `internal/store/contract_test.go` | Shared behaviour suite run against every `Store` |
| `internal/httpapi/api.go` | Note handlers + validation |
| `internal/httpapi/json.go` | `writeJSON`, `writeError` |
| `internal/httpapi/middleware.go` | `Logging`, `Recover` |
| `internal/web/web.go` | SPA handler + `//go:embed all:dist` |

**Client (`client/src/`)**
| File | Responsibility |
|---|---|
| `crypto/encoding.ts` | base64, base64url, utf8 helpers |
| `crypto/derive.ts` | name → `{id, key}` |
| `crypto/cipher.ts` | `encryptNote`, `decryptNote`, `DecryptError` |
| `names/names.ts` | `normalizeName`, `generateName`, `randomIndex`, `estimateStrength` |
| `names/wordlist.ts` | Generated EFF wordlist |
| `notes/api.ts` | `fetch` wrapper + typed errors |
| `notes/pending.ts` | ciphertext-only pending-save storage |
| `notes/noteSync.ts` | Note lifecycle state machine |
| `notes/useNote.ts` | React binding for `NoteSync` |
| `pages/Home.tsx`, `pages/NotePage.tsx` | UI |
| `App.tsx`, `main.tsx` | Routing, bootstrap |

---

### Task 1: Server reset + config package

**Concept (teach before coding):** A Go **module** (`go.mod`) is the unit of versioning; **packages** are directories. Anything under `internal/` can only be imported by code rooted at the parent of `internal/` — the compiler enforces the boundary. Tests live next to code in `_test.go` files and run with `go test ./...`. **Table-driven tests** loop over a slice of cases with `t.Run` for named subtests. Passing `os.Getenv` as a *function value* (`func(string) string`) makes config testable without touching real env vars.

**Files:**
- Delete: `server/main.go`, `server/db/`, `server/handlers/`, `server/middleware/`, `server/models/`, `server/routes/`, `server/services/`, `server/utils/`
- Create: `server/internal/config/config.go`, `server/internal/config/config_test.go`, `server/.env.example`, `LEARNING.md`
- Modify: `server/go.mod`, `server/.air.toml`, `.gitignore`

**Interfaces:**
- Produces: `config.Load(getenv func(string) string) config.Config` with fields `Addr string`, `DBPath string`.

- [ ] **Step 1: Remove the old server code and dependencies**

```bash
cd server
git rm -r -q main.go db handlers middleware models routes services utils
go mod edit -go=1.24
go mod edit -droprequire=github.com/gorilla/mux -droprequire=github.com/jackc/pgx/v5 -droprequire=github.com/joho/godotenv
```

- [ ] **Step 2: Write the failing config test**

`server/internal/config/config_test.go`:
```go
package config

import "testing"

func TestLoad(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want Config
	}{
		{
			name: "defaults when nothing is set",
			env:  map[string]string{},
			want: Config{Addr: ":8080", DBPath: "./data/notes.db"},
		},
		{
			name: "env overrides defaults",
			env:  map[string]string{"ADDR": ":9999", "DB_PATH": "/tmp/x.db"},
			want: Config{Addr: ":9999", DBPath: "/tmp/x.db"},
		},
		{
			name: "empty values fall back to defaults",
			env:  map[string]string{"ADDR": "", "DB_PATH": ""},
			want: Config{Addr: ":8080", DBPath: "./data/notes.db"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			getenv := func(key string) string { return tc.env[key] }
			if got := Load(getenv); got != tc.want {
				t.Fatalf("Load() = %+v, want %+v", got, tc.want)
			}
		})
	}
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd server && go test ./internal/config/`
Expected: FAIL — `undefined: Config` / `undefined: Load`.

- [ ] **Step 4: Implement config**

`server/internal/config/config.go`:
```go
// Package config turns environment variables into a typed Config.
package config

// Config holds everything the server needs to start.
type Config struct {
	Addr   string // listen address, e.g. ":8080"
	DBPath string // path to the SQLite database file
}

// Load reads configuration using getenv (pass os.Getenv in production).
// Unset or empty variables fall back to defaults that work locally.
func Load(getenv func(string) string) Config {
	cfg := Config{Addr: ":8080", DBPath: "./data/notes.db"}
	if v := getenv("ADDR"); v != "" {
		cfg.Addr = v
	}
	if v := getenv("DB_PATH"); v != "" {
		cfg.DBPath = v
	}
	return cfg
}
```

- [ ] **Step 5: Run tests and tidy**

Run: `cd server && go test ./... && go mod tidy && go vet ./...`
Expected: `ok  github.com/Mesfrum/flako/server/internal/config`; `go.mod` now has no `require` block.

- [ ] **Step 6: Update air, env example, gitignore**

In `server/.air.toml` change these two lines under `[build]`:
```toml
  cmd = "go build -o ./tmp/main.exe ./cmd/server"
  exclude_dir = ["assets", "tmp", "vendor", "testdata", "data", "internal/web/dist"]
```

`server/.env.example`:
```bash
# All optional — defaults work for local development.
# ADDR=:8080
# DB_PATH=./data/notes.db
```

In the root `.gitignore`, replace the line `dist` (in the Client section) with `client/dist`, and append:
```gitignore

# SQLite data
server/data/
```

- [ ] **Step 7: Start LEARNING.md**

`LEARNING.md`:
```markdown
# Learning Log

One entry per concept, written for future-me coming back after a long break.

## Go: modules, packages, `internal/`
- `go.mod` declares the module path and Go version; every directory is a package.
- Code under `internal/` is importable only from its parent tree — compiler-enforced privacy.
- `go test ./...` runs every package's `_test.go` files; `go vet` catches suspicious code.

## Go: table-driven tests
- A slice of `struct{name; input; want}` cases + `t.Run(tc.name, ...)` = one named subtest per case.
- Run a single case: `go test ./internal/config -run 'TestLoad/defaults'`.

## Go: functions as values (dependency injection, the small way)
- `Load(getenv func(string) string)` takes a function, so tests pass a fake instead of setting real env vars.
- Same idea as passing a callback in JS; no framework needed.
```

- [ ] **Step 8: Commit**

```bash
git add -A server .gitignore LEARNING.md
git commit -m "refactor(server): reset to internal/ layout with config package

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Store contract + in-memory store

**Concept:** Go **interfaces are satisfied implicitly** — any type with the right methods *is* a `Store`; no `implements` keyword. `var _ Store = (*Memory)(nil)` is a compile-time assertion of that. **Sentinel errors** (`var ErrNotFound = errors.New(...)`) are compared with `errors.Is`, which also sees through wrapping. A **custom error type** carries data (`ConflictError{Current}`); its `Unwrap()` method lets `errors.Is(err, ErrVersionConflict)` succeed while `errors.As(err, &ce)` extracts the data. `sync.Mutex` + `defer mu.Unlock()` guards a map from concurrent goroutines. A **contract test** is one test suite every implementation must pass — written once, run against Memory now and SQLite next task.

**Files:**
- Create: `server/internal/store/store.go`, `server/internal/store/memory.go`, `server/internal/store/contract_test.go`, `server/internal/store/memory_test.go`
- Modify: `LEARNING.md`

**Interfaces:**
- Produces:
  ```go
  var ErrNotFound, ErrVersionConflict error
  type ConflictError struct{ Current int64 }          // Error(), Unwrap() error
  type Note struct { ID string; Ciphertext, IV []byte; Version int64; CreatedAt, UpdatedAt time.Time }
  type Store interface {
      GetNote(ctx context.Context, id string) (Note, error)
      PutNote(ctx context.Context, n Note, baseVersion int64) (Note, error)
  }
  func NewMemory() *Memory
  func nowMilli() time.Time   // package-private
  func runContract(t *testing.T, newStore func(t *testing.T) Store)   // test-only
  ```

- [ ] **Step 1: Write the store types (no behaviour yet, needed to compile tests)**

`server/internal/store/store.go`:
```go
// Package store persists encrypted notes. It never sees plaintext.
package store

import (
	"context"
	"errors"
	"fmt"
	"time"
)

var (
	// ErrNotFound means no note exists with the given id.
	ErrNotFound = errors.New("note not found")
	// ErrVersionConflict means the caller's baseVersion is not the current version.
	ErrVersionConflict = errors.New("version conflict")
)

// ConflictError reports a version conflict along with the version the store holds.
// errors.Is(err, ErrVersionConflict) is true for it.
type ConflictError struct {
	Current int64 // 0 when the note does not exist
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("version conflict: current version is %d", e.Current)
}

func (e *ConflictError) Unwrap() error { return ErrVersionConflict }

// Note is an encrypted note as stored. Ciphertext and IV are opaque bytes.
type Note struct {
	ID         string
	Ciphertext []byte
	IV         []byte
	Version    int64
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// Store is the persistence boundary. Implementations must be safe for concurrent use.
type Store interface {
	GetNote(ctx context.Context, id string) (Note, error)
	// PutNote stores n.Ciphertext and n.IV under n.ID if baseVersion equals the
	// current version (0 = note must not exist yet). On success the returned
	// Note has Version = baseVersion+1. Otherwise it returns a *ConflictError.
	PutNote(ctx context.Context, n Note, baseVersion int64) (Note, error)
}

// nowMilli returns the current UTC time truncated to milliseconds, the
// resolution we persist, so every Store returns identical timestamps.
func nowMilli() time.Time {
	return time.UnixMilli(time.Now().UnixMilli()).UTC()
}
```

- [ ] **Step 2: Write the contract suite and the Memory test that runs it**

`server/internal/store/contract_test.go`:
```go
package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
)

const testID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" // 43 chars, like a real id

func sampleNote(content string) Note {
	return Note{ID: testID, Ciphertext: []byte(content), IV: bytes.Repeat([]byte{7}, 12)}
}

// runContract is the behaviour every Store implementation must have.
func runContract(t *testing.T, newStore func(t *testing.T) Store) {
	ctx := context.Background()

	t.Run("get missing note returns ErrNotFound", func(t *testing.T) {
		s := newStore(t)
		_, err := s.GetNote(ctx, testID)
		if !errors.Is(err, ErrNotFound) {
			t.Fatalf("GetNote err = %v, want ErrNotFound", err)
		}
	})

	t.Run("create with base 0 then read back", func(t *testing.T) {
		s := newStore(t)
		in := sampleNote("hello ciphertext")
		saved, err := s.PutNote(ctx, in, 0)
		if err != nil {
			t.Fatalf("PutNote: %v", err)
		}
		if saved.Version != 1 {
			t.Errorf("Version = %d, want 1", saved.Version)
		}
		if saved.CreatedAt.IsZero() || !saved.UpdatedAt.Equal(saved.CreatedAt) {
			t.Errorf("timestamps = %v / %v, want equal and non-zero", saved.CreatedAt, saved.UpdatedAt)
		}
		got, err := s.GetNote(ctx, testID)
		if err != nil {
			t.Fatalf("GetNote: %v", err)
		}
		if !bytes.Equal(got.Ciphertext, in.Ciphertext) || !bytes.Equal(got.IV, in.IV) {
			t.Errorf("GetNote bytes = %q/%v, want %q/%v", got.Ciphertext, got.IV, in.Ciphertext, in.IV)
		}
		if got.Version != 1 || !got.CreatedAt.Equal(saved.CreatedAt) {
			t.Errorf("GetNote = v%d created %v, want v1 created %v", got.Version, got.CreatedAt, saved.CreatedAt)
		}
	})

	t.Run("update with current base increments version and keeps created_at", func(t *testing.T) {
		s := newStore(t)
		first, err := s.PutNote(ctx, sampleNote("first"), 0)
		if err != nil {
			t.Fatal(err)
		}
		second, err := s.PutNote(ctx, sampleNote("second"), 1)
		if err != nil {
			t.Fatalf("update: %v", err)
		}
		if second.Version != 2 {
			t.Errorf("Version = %d, want 2", second.Version)
		}
		if !second.CreatedAt.Equal(first.CreatedAt) {
			t.Errorf("CreatedAt changed: %v -> %v", first.CreatedAt, second.CreatedAt)
		}
		got, _ := s.GetNote(ctx, testID)
		if string(got.Ciphertext) != "second" {
			t.Errorf("content = %q, want %q", got.Ciphertext, "second")
		}
	})

	conflicts := []struct {
		name        string
		setupSaves  int   // how many successful saves happen first
		base        int64 // baseVersion of the losing write
		wantCurrent int64
	}{
		{"create when note exists", 1, 0, 1},
		{"stale base version", 2, 1, 2},
		{"base version from the future", 1, 5, 1},
		{"update of a missing note", 0, 3, 0},
	}
	for _, tc := range conflicts {
		t.Run("conflict: "+tc.name, func(t *testing.T) {
			s := newStore(t)
			for v := range tc.setupSaves {
				if _, err := s.PutNote(ctx, sampleNote("setup"), int64(v)); err != nil {
					t.Fatalf("setup save %d: %v", v, err)
				}
			}
			_, err := s.PutNote(ctx, sampleNote("loser"), tc.base)
			var ce *ConflictError
			if !errors.As(err, &ce) {
				t.Fatalf("err = %v, want *ConflictError", err)
			}
			if !errors.Is(err, ErrVersionConflict) {
				t.Errorf("errors.Is(err, ErrVersionConflict) = false")
			}
			if ce.Current != tc.wantCurrent {
				t.Errorf("Current = %d, want %d", ce.Current, tc.wantCurrent)
			}
			if tc.setupSaves > 0 {
				got, _ := s.GetNote(ctx, testID)
				if string(got.Ciphertext) != "setup" {
					t.Errorf("losing write changed content to %q", got.Ciphertext)
				}
			}
		})
	}

	t.Run("store does not keep a reference to the caller's bytes", func(t *testing.T) {
		s := newStore(t)
		in := sampleNote("original")
		if _, err := s.PutNote(ctx, in, 0); err != nil {
			t.Fatal(err)
		}
		in.Ciphertext[0] = 'X'
		got, _ := s.GetNote(ctx, testID)
		if string(got.Ciphertext) != "original" {
			t.Errorf("stored content = %q, want %q", got.Ciphertext, "original")
		}
	})

	t.Run("concurrent creates: exactly one wins", func(t *testing.T) {
		s := newStore(t)
		const writers = 20
		var (
			wg        sync.WaitGroup
			mu        sync.Mutex
			wins      int
			conflicts int
			others    []error
		)
		for i := range writers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, err := s.PutNote(ctx, sampleNote(fmt.Sprintf("writer-%d", i)), 0)
				mu.Lock()
				defer mu.Unlock()
				switch {
				case err == nil:
					wins++
				case errors.Is(err, ErrVersionConflict):
					conflicts++
				default:
					others = append(others, err)
				}
			}()
		}
		wg.Wait()
		for _, err := range others {
			t.Errorf("unexpected error: %v", err)
		}
		if wins != 1 || conflicts != writers-1 {
			t.Fatalf("wins=%d conflicts=%d, want 1 and %d", wins, conflicts, writers-1)
		}
	})
}
```

`server/internal/store/memory_test.go`:
```go
package store

import "testing"

func TestMemoryContract(t *testing.T) {
	runContract(t, func(t *testing.T) Store { return NewMemory() })
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd server && go test ./internal/store/`
Expected: FAIL — `undefined: NewMemory`.

- [ ] **Step 4: Implement Memory**

`server/internal/store/memory.go`:
```go
package store

import (
	"bytes"
	"context"
	"sync"
)

// Memory is an in-memory Store. It is the reference implementation of the
// contract and the fake used by handler tests. Data is lost on restart.
type Memory struct {
	mu    sync.Mutex
	notes map[string]Note
}

var _ Store = (*Memory)(nil) // compile-time check: *Memory satisfies Store

func NewMemory() *Memory {
	return &Memory{notes: make(map[string]Note)}
}

func (m *Memory) GetNote(_ context.Context, id string) (Note, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n, ok := m.notes[id]
	if !ok {
		return Note{}, ErrNotFound
	}
	return cloneNote(n), nil
}

func (m *Memory) PutNote(_ context.Context, n Note, baseVersion int64) (Note, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	current, exists := m.notes[n.ID]
	// A missing note has version 0, so "create" and "update" are the same check.
	if baseVersion != current.Version {
		return Note{}, &ConflictError{Current: current.Version}
	}

	now := nowMilli()
	stored := Note{
		ID:         n.ID,
		Ciphertext: bytes.Clone(n.Ciphertext),
		IV:         bytes.Clone(n.IV),
		Version:    current.Version + 1,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	if exists {
		stored.CreatedAt = current.CreatedAt
	}
	m.notes[n.ID] = stored
	return cloneNote(stored), nil
}

func cloneNote(n Note) Note {
	n.Ciphertext = bytes.Clone(n.Ciphertext)
	n.IV = bytes.Clone(n.IV)
	return n
}
```

- [ ] **Step 5: Run tests, including the race detector**

Run: `cd server && go test ./internal/store/ -v`
Expected: PASS for every `TestMemoryContract/...` subtest.

Then try: `go test -race ./internal/store/`. On Windows `-race` needs CGO + a C compiler; if it errors with "-race requires cgo", note it in chat and skip — the mutex is still correct.

- [ ] **Step 6: Append to LEARNING.md**

```markdown

## Go: interfaces are implicit
- A type satisfies an interface just by having its methods. `var _ Store = (*Memory)(nil)` makes the compiler check it.
- Design tip: define interfaces where they're *used* (here, the store package owns `Store` because handlers depend on it).

## Go: errors — sentinels, wrapping, custom types
- Sentinel: `var ErrNotFound = errors.New("...")`; compare with `errors.Is(err, ErrNotFound)`, never `==` on wrapped errors.
- Wrap with context: `fmt.Errorf("get note %s: %w", id, err)` — `%w` keeps the original reachable.
- Custom type with data: `type ConflictError struct{ Current int64 }` + `Unwrap() error { return ErrVersionConflict }`.
  `errors.Is` → "is it a conflict?", `errors.As(err, &ce)` → "give me the details".

## Go: mutex + defer
- `mu.Lock(); defer mu.Unlock()` — `defer` runs when the function returns, even on early return or panic.
- Maps are NOT safe for concurrent use; guard them.

## Go: goroutines + WaitGroup
- `go func(){...}()` starts a goroutine. `wg.Add(1)` before, `defer wg.Done()` inside, `wg.Wait()` to join.
- Since Go 1.22 each loop iteration has its own `i`, so capturing it in a goroutine is safe (it wasn't before!).

## Testing: contract tests
- One suite (`runContract`) run against every implementation guarantees they behave identically.
```

- [ ] **Step 7: Commit**

```bash
git add server/internal/store LEARNING.md
git commit -m "feat(server): store contract, sentinel errors, in-memory store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: SQLite store + migration runner

**Concept:** `database/sql` is Go's generic DB API; a **driver** (`modernc.org/sqlite`, pure Go) registers itself via a blank import side effect. `*sql.DB` is a *pool*, safe for concurrent use. `//go:embed migrations/*.sql` bakes files into the binary as an `embed.FS`; `io/fs` lets code read either that or a test `fstest.MapFS` through the same interface. **Migrations** run each new `.sql` file inside a **transaction** — all or nothing — and record it in `schema_migrations`. Concurrency is solved with **single atomic statements**: `INSERT ... ON CONFLICT DO NOTHING` (create) and `UPDATE ... WHERE version = ? RETURNING ...` (update) — no read-then-write race window. SQLite **WAL** mode lets readers proceed during a write; `busy_timeout` makes a blocked writer wait instead of failing.

**Files:**
- Create: `server/internal/store/migrate.go`, `server/internal/store/sqlite.go`, `server/internal/store/migrations/001_notes.sql`, `server/internal/store/sqlite_test.go`
- Modify: `server/go.mod`, `server/go.sum`, `LEARNING.md`

**Interfaces:**
- Consumes: everything from Task 2.
- Produces:
  ```go
  func OpenSQLite(ctx context.Context, path string) (*SQLite, error)  // creates parent dir, applies migrations
  func (s *SQLite) Close() error
  func openDB(ctx context.Context, path string) (*sql.DB, error)      // package-private, no migrations
  func migrate(ctx context.Context, db *sql.DB, fsys fs.FS) error     // package-private
  ```

- [ ] **Step 1: Add the driver**

```bash
cd server
go get modernc.org/sqlite@v1.38.2
```
Expected: `go.mod` gains `require modernc.org/sqlite v1.38.2` (plus indirect deps).

- [ ] **Step 2: Write the failing tests**

`server/internal/store/sqlite_test.go`:
```go
package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func openTestSQLite(t *testing.T, path string) *SQLite {
	t.Helper()
	s, err := OpenSQLite(context.Background(), path)
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestSQLiteContract(t *testing.T) {
	runContract(t, func(t *testing.T) Store {
		return openTestSQLite(t, filepath.Join(t.TempDir(), "notes.db"))
	})
}

func TestSQLiteCreatesParentDirectory(t *testing.T) {
	openTestSQLite(t, filepath.Join(t.TempDir(), "nested", "dir", "notes.db"))
}

func TestSQLiteDataSurvivesReopen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "notes.db")

	first, err := OpenSQLite(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.PutNote(ctx, sampleNote("persisted"), 0); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	second := openTestSQLite(t, path) // migrations run again: must be a no-op
	got, err := second.GetNote(ctx, testID)
	if err != nil {
		t.Fatalf("GetNote after reopen: %v", err)
	}
	if string(got.Ciphertext) != "persisted" || got.Version != 1 {
		t.Errorf("got %q v%d, want %q v1", got.Ciphertext, got.Version, "persisted")
	}
}

func TestMigrateIsIdempotent(t *testing.T) {
	ctx := context.Background()
	db := openRawDB(t)
	fsys := fstest.MapFS{"migrations/001_a.sql": {Data: []byte("CREATE TABLE a (x INTEGER);")}}

	for range 2 {
		if err := migrate(ctx, db, fsys); err != nil {
			t.Fatalf("migrate: %v", err)
		}
	}
	if n := countRows(t, db, "schema_migrations"); n != 1 {
		t.Errorf("schema_migrations rows = %d, want 1", n)
	}
}

func TestMigrateRollsBackAFailedMigration(t *testing.T) {
	ctx := context.Background()
	db := openRawDB(t)
	fsys := fstest.MapFS{
		"migrations/001_ok.sql":  {Data: []byte("CREATE TABLE ok_table (x INTEGER);")},
		"migrations/002_bad.sql": {Data: []byte("CREATE TABLE half_done (x INTEGER); THIS IS NOT SQL;")},
	}

	if err := migrate(ctx, db, fsys); err == nil {
		t.Fatal("migrate succeeded, want error from 002_bad.sql")
	}
	if n := countRows(t, db, "schema_migrations"); n != 1 {
		t.Errorf("schema_migrations rows = %d, want 1 (only 001)", n)
	}
	var name string
	err := db.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name='half_done'`).Scan(&name)
	if err != sql.ErrNoRows {
		t.Errorf("table half_done exists (err=%v); the failed migration was not rolled back", err)
	}
}

func openRawDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := openDB(context.Background(), filepath.Join(t.TempDir(), "raw.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func countRows(t *testing.T, db *sql.DB, table string) int {
	t.Helper()
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd server && go test ./internal/store/`
Expected: FAIL — `undefined: SQLite`, `undefined: OpenSQLite`, `undefined: openDB`, `undefined: migrate`.

- [ ] **Step 4: Write the migration file**

`server/internal/store/migrations/001_notes.sql`:
```sql
-- Notes are opaque encrypted blobs. The server never sees names or plaintext.
CREATE TABLE notes (
  id          TEXT PRIMARY KEY,   -- base64url(HKDF(master, "id")), 43 chars
  ciphertext  BLOB NOT NULL,
  iv          BLOB NOT NULL,      -- 12 bytes
  version     INTEGER NOT NULL,   -- 1 on first save, +1 per save
  created_at  INTEGER NOT NULL,   -- unix ms
  updated_at  INTEGER NOT NULL    -- unix ms
);
```

- [ ] **Step 5: Implement the migration runner**

`server/internal/store/migrate.go`:
```go
package store

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"time"
)

// migrate applies every migrations/*.sql file in fsys that has not been applied
// yet, in lexical order (so name them 001_, 002_, ...). Each file runs in its
// own transaction together with its bookkeeping row: all of it or none of it.
// Never edit a migration that has shipped — add a new file instead.
func migrate(ctx context.Context, db *sql.DB, fsys fs.FS) error {
	const createTable = `CREATE TABLE IF NOT EXISTS schema_migrations (
		version    TEXT PRIMARY KEY,
		applied_at INTEGER NOT NULL
	)`
	if _, err := db.ExecContext(ctx, createTable); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	files, err := fs.Glob(fsys, "migrations/*.sql")
	if err != nil {
		return fmt.Errorf("list migrations: %w", err)
	}
	sort.Strings(files)

	for _, file := range files {
		version := path.Base(file)

		var applied int
		err := db.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM schema_migrations WHERE version = ?`, version).Scan(&applied)
		if err != nil {
			return fmt.Errorf("check migration %s: %w", version, err)
		}
		if applied > 0 {
			continue
		}

		body, err := fs.ReadFile(fsys, file)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", version, err)
		}
		if err := applyMigration(ctx, db, version, string(body)); err != nil {
			return err
		}
	}
	return nil
}

func applyMigration(ctx context.Context, db *sql.DB, version, body string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin migration %s: %w", version, err)
	}
	defer tx.Rollback() // no-op after a successful Commit

	if _, err := tx.ExecContext(ctx, body); err != nil {
		return fmt.Errorf("apply migration %s: %w", version, err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
		version, time.Now().UnixMilli()); err != nil {
		return fmt.Errorf("record migration %s: %w", version, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit migration %s: %w", version, err)
	}
	return nil
}
```

- [ ] **Step 6: Implement the SQLite store**

`server/internal/store/sqlite.go`:
```go
package store

import (
	"bytes"
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite" // registers the "sqlite" driver with database/sql
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// SQLite is the production Store: one database file on disk.
type SQLite struct {
	db *sql.DB
}

var _ Store = (*SQLite)(nil)

// OpenSQLite opens (creating if needed) the database at path and applies migrations.
func OpenSQLite(ctx context.Context, path string) (*SQLite, error) {
	db, err := openDB(ctx, path)
	if err != nil {
		return nil, err
	}
	if err := migrate(ctx, db, migrationsFS); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return &SQLite{db: db}, nil
}

// openDB opens the database with our pragmas applied to every pooled connection.
func openDB(ctx context.Context, path string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create db directory: %w", err)
	}
	// busy_timeout first, so a connection waits for the lock while switching to WAL.
	dsn := path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	return db, nil
}

func (s *SQLite) Close() error { return s.db.Close() }

func (s *SQLite) GetNote(ctx context.Context, id string) (Note, error) {
	var (
		n                  Note
		created, updated   int64
	)
	err := s.db.QueryRowContext(ctx,
		`SELECT id, ciphertext, iv, version, created_at, updated_at FROM notes WHERE id = ?`, id,
	).Scan(&n.ID, &n.Ciphertext, &n.IV, &n.Version, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return Note{}, ErrNotFound
	}
	if err != nil {
		return Note{}, fmt.Errorf("get note: %w", err)
	}
	n.CreatedAt = time.UnixMilli(created).UTC()
	n.UpdatedAt = time.UnixMilli(updated).UTC()
	return n, nil
}

func (s *SQLite) PutNote(ctx context.Context, n Note, baseVersion int64) (Note, error) {
	now := nowMilli()
	if baseVersion == 0 {
		return s.create(ctx, n, now)
	}
	return s.update(ctx, n, baseVersion, now)
}

// create inserts version 1. ON CONFLICT DO NOTHING makes "insert if absent" a
// single atomic statement: of N concurrent creates, exactly one affects a row.
func (s *SQLite) create(ctx context.Context, n Note, now time.Time) (Note, error) {
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO notes (id, ciphertext, iv, version, created_at, updated_at)
		 VALUES (?, ?, ?, 1, ?, ?)
		 ON CONFLICT(id) DO NOTHING`,
		n.ID, n.Ciphertext, n.IV, now.UnixMilli(), now.UnixMilli())
	if err != nil {
		return Note{}, fmt.Errorf("create note: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return Note{}, fmt.Errorf("create note: %w", err)
	}
	if affected == 0 {
		return Note{}, s.conflict(ctx, n.ID)
	}
	return Note{
		ID: n.ID, Ciphertext: bytes.Clone(n.Ciphertext), IV: bytes.Clone(n.IV),
		Version: 1, CreatedAt: now, UpdatedAt: now,
	}, nil
}

// update only matches the row if its version is still baseVersion.
func (s *SQLite) update(ctx context.Context, n Note, baseVersion int64, now time.Time) (Note, error) {
	var version, created int64
	err := s.db.QueryRowContext(ctx,
		`UPDATE notes
		 SET ciphertext = ?, iv = ?, version = version + 1, updated_at = ?
		 WHERE id = ? AND version = ?
		 RETURNING version, created_at`,
		n.Ciphertext, n.IV, now.UnixMilli(), n.ID, baseVersion,
	).Scan(&version, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return Note{}, s.conflict(ctx, n.ID)
	}
	if err != nil {
		return Note{}, fmt.Errorf("update note: %w", err)
	}
	return Note{
		ID: n.ID, Ciphertext: bytes.Clone(n.Ciphertext), IV: bytes.Clone(n.IV),
		Version: version, CreatedAt: time.UnixMilli(created).UTC(), UpdatedAt: now,
	}, nil
}

// conflict builds a *ConflictError carrying the current version (0 if missing).
func (s *SQLite) conflict(ctx context.Context, id string) error {
	var current int64
	err := s.db.QueryRowContext(ctx, `SELECT version FROM notes WHERE id = ?`, id).Scan(&current)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("read current version: %w", err)
	}
	return &ConflictError{Current: current}
}
```

- [ ] **Step 7: Run the tests**

Run: `cd server && gofmt -l . ; go test ./internal/store/ -v`
Expected: `gofmt -l` prints nothing (run `gofmt -w .` if it lists files); all `TestMemoryContract/...`, `TestSQLiteContract/...`, `TestSQLite...`, `TestMigrate...` PASS — including `concurrent_creates:_exactly_one_wins` for SQLite.

- [ ] **Step 8: Append to LEARNING.md**

```markdown

## Go: database/sql
- `sql.Open` returns a *pool*, not a connection; it's safe to share. `Ping` actually connects.
- Drivers register via a blank import: `import _ "modernc.org/sqlite"`.
- `QueryRow(...).Scan(&a, &b)`; no row → `sql.ErrNoRows`. `Exec` → `RowsAffected()`.
- Transactions: `tx, _ := db.BeginTx(ctx, nil); defer tx.Rollback(); ...; tx.Commit()` — the deferred Rollback is a no-op after Commit.

## Go: //go:embed and io/fs
- `//go:embed migrations/*.sql` + `var f embed.FS` puts files inside the binary.
- Accept `fs.FS` in functions; prod passes the `embed.FS`, tests pass `fstest.MapFS{...}`.

## Databases: migrations
- Numbered SQL files + a `schema_migrations` table recording which ran. Each runs in a transaction.
- Never edit a shipped migration; add a new one. Fresh machines get the schema automatically.

## Databases: avoiding races with atomic statements
- Read-then-write ("SELECT version; if ok UPDATE") has a gap where another writer sneaks in.
- Instead: `INSERT ... ON CONFLICT DO NOTHING` and `UPDATE ... WHERE version = ?` — the DB checks and writes in one step.
- This is **optimistic concurrency**: assume no conflict, detect it, let the client decide.

## SQLite: WAL + busy_timeout
- WAL lets readers read while one writer writes. SQLite allows one writer at a time.
- `busy_timeout(5000)`: wait up to 5s for the write lock instead of failing immediately with SQLITE_BUSY.
```

- [ ] **Step 9: Commit**

```bash
git add server LEARNING.md
git commit -m "feat(server): SQLite store with embedded transactional migrations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: HTTP API handlers

**Concept:** Since Go 1.22, `http.ServeMux` understands `"GET /api/notes/{id}"`: method matching, wildcards via `r.PathValue("id")`, and "most specific pattern wins". A handler is anything with `ServeHTTP(w, r)`; `http.HandlerFunc` adapts a plain function. **Struct tags** (`json:"base_version"`) map JSON names to fields; a **pointer field** (`*int64`) distinguishes "missing" from zero. `http.MaxBytesReader` caps the body and yields `*http.MaxBytesError` when exceeded. `httptest.NewRecorder` lets tests call handlers without a network. Never leak internal error text to clients — log it, return a generic 500.

**Files:**
- Create: `server/internal/httpapi/api.go`, `server/internal/httpapi/json.go`, `server/internal/httpapi/api_test.go`
- Modify: `LEARNING.md`

**Interfaces:**
- Consumes: `store.Store`, `store.ErrNotFound`, `*store.ConflictError`, `store.NewMemory()`.
- Produces:
  ```go
  func New(s store.Store, logger *slog.Logger) *API
  func (a *API) Routes(mux *http.ServeMux)   // registers GET/PUT /api/notes/{id}, GET /healthz, /api/ (JSON 404)
  func writeJSON(w http.ResponseWriter, status int, v any)
  func writeError(w http.ResponseWriter, status int, msg string)
  ```
  Wire format: GET 200 `{"ciphertext","iv","version","updated_at"}`; PUT body `{"ciphertext","iv","base_version"}` → 200 `{"version","updated_at"}`, 409 `{"error","current_version"}`; errors `{"error"}`.

- [ ] **Step 1: Write the failing tests**

`server/internal/httpapi/api_test.go`:
```go
package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Mesfrum/flako/server/internal/store"
)

var (
	validID = strings.Repeat("a", 43)
	validIV = base64.StdEncoding.EncodeToString(make([]byte, 12))
	validCT = base64.StdEncoding.EncodeToString(make([]byte, 16)) // smallest legal: an empty note's GCM tag
)

func newHandler(s store.Store) http.Handler {
	mux := http.NewServeMux()
	New(s, slog.New(slog.NewTextHandler(io.Discard, nil))).Routes(mux)
	return mux
}

func do(t *testing.T, h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func putBody(ct, iv string, base int64) string {
	return `{"ciphertext":"` + ct + `","iv":"` + iv + `","base_version":` + jsonInt(base) + `}`
}

func jsonInt(n int64) string { b, _ := json.Marshal(n); return string(b) }

func decode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.NewDecoder(rec.Body).Decode(&v); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return v
}

func TestGetMissingNoteIs404(t *testing.T) {
	rec := do(t, newHandler(store.NewMemory()), "GET", "/api/notes/"+validID, "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if got := decode[map[string]string](t, rec)["error"]; got == "" {
		t.Errorf("missing error message")
	}
}

func TestInvalidIDIs400(t *testing.T) {
	h := newHandler(store.NewMemory())
	for _, id := range []string{"short", strings.Repeat("a", 44), strings.Repeat("a", 42) + "!"} {
		for _, method := range []string{"GET", "PUT"} {
			rec := do(t, h, method, "/api/notes/"+id, putBody(validCT, validIV, 0))
			if rec.Code != http.StatusBadRequest {
				t.Errorf("%s id=%q: status = %d, want 400", method, id, rec.Code)
			}
		}
	}
}

func TestPutThenGetRoundTrip(t *testing.T) {
	h := newHandler(store.NewMemory())
	ct := base64.StdEncoding.EncodeToString([]byte("0123456789abcdef-more"))

	rec := do(t, h, "PUT", "/api/notes/"+validID, putBody(ct, validIV, 0))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, body %s", rec.Code, rec.Body)
	}
	put := decode[putResponse](t, rec)
	if put.Version != 1 || put.UpdatedAt <= 0 {
		t.Errorf("PUT response = %+v, want version 1 and updated_at > 0", put)
	}

	rec = do(t, h, "GET", "/api/notes/"+validID, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d", rec.Code)
	}
	got := decode[noteResponse](t, rec)
	want := noteResponse{Ciphertext: ct, IV: validIV, Version: 1, UpdatedAt: put.UpdatedAt}
	if got != want {
		t.Errorf("GET = %+v, want %+v", got, want)
	}
}

func TestPutMinimalCiphertextIsAccepted(t *testing.T) {
	// An encrypted empty note is still >= 16 bytes, so "delete all text" must save.
	rec := do(t, newHandler(store.NewMemory()), "PUT", "/api/notes/"+validID, putBody(validCT, validIV, 0))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", rec.Code, rec.Body)
	}
}

func TestPutValidation(t *testing.T) {
	cases := []struct{ name, body string }{
		{"invalid JSON", `{"ciphertext":`},
		{"unknown field", `{"ciphertext":"` + validCT + `","iv":"` + validIV + `","base_version":0,"name":"taco"}`},
		{"missing base_version", `{"ciphertext":"` + validCT + `","iv":"` + validIV + `"}`},
		{"negative base_version", putBody(validCT, validIV, -1)},
		{"ciphertext not base64", putBody("!!!", validIV, 0)},
		{"ciphertext too short", putBody(base64.StdEncoding.EncodeToString(make([]byte, 15)), validIV, 0)},
		{"iv wrong length", putBody(validCT, base64.StdEncoding.EncodeToString(make([]byte, 11)), 0)},
		{"iv not base64", putBody(validCT, "!!!", 0)},
	}
	h := newHandler(store.NewMemory())
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := do(t, h, "PUT", "/api/notes/"+validID, tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400 (body %s)", rec.Code, rec.Body)
			}
		})
	}
}

func TestPutConflictReportsCurrentVersion(t *testing.T) {
	h := newHandler(store.NewMemory())
	do(t, h, "PUT", "/api/notes/"+validID, putBody(validCT, validIV, 0))

	rec := do(t, h, "PUT", "/api/notes/"+validID, putBody(validCT, validIV, 0))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
	if got := decode[errorResponse](t, rec); got.CurrentVersion == nil || *got.CurrentVersion != 1 {
		t.Errorf("current_version = %v, want 1", got.CurrentVersion)
	}
}

func TestPutConflictOnMissingNoteReportsZero(t *testing.T) {
	rec := do(t, newHandler(store.NewMemory()), "PUT", "/api/notes/"+validID, putBody(validCT, validIV, 3))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"current_version":0`) {
		t.Errorf("body %s must include current_version 0", rec.Body)
	}
}

func TestPutTooLargeIs413(t *testing.T) {
	huge := strings.Repeat("A", 2<<20)
	rec := do(t, newHandler(store.NewMemory()), "PUT", "/api/notes/"+validID, putBody(huge, validIV, 0))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
}

type failingStore struct{}

func (failingStore) GetNote(context.Context, string) (store.Note, error) {
	return store.Note{}, errors.New("disk on fire")
}
func (failingStore) PutNote(context.Context, store.Note, int64) (store.Note, error) {
	return store.Note{}, errors.New("disk on fire")
}

func TestStoreFailureIsGeneric500(t *testing.T) {
	h := newHandler(failingStore{})
	for _, rec := range []*httptest.ResponseRecorder{
		do(t, h, "GET", "/api/notes/"+validID, ""),
		do(t, h, "PUT", "/api/notes/"+validID, putBody(validCT, validIV, 0)),
	} {
		if rec.Code != http.StatusInternalServerError {
			t.Errorf("status = %d, want 500", rec.Code)
		}
		if strings.Contains(rec.Body.String(), "disk on fire") {
			t.Errorf("internal error leaked to client: %s", rec.Body)
		}
	}
}

func TestUnknownAPIPathIsJSON404(t *testing.T) {
	rec := do(t, newHandler(store.NewMemory()), "GET", "/api/nope", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q, want JSON", ct)
	}
}

func TestHealthz(t *testing.T) {
	rec := do(t, newHandler(store.NewMemory()), "GET", "/healthz", "")
	if rec.Code != http.StatusOK || rec.Body.String() != "ok" {
		t.Fatalf("got %d %q, want 200 ok", rec.Code, rec.Body)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && go test ./internal/httpapi/`
Expected: FAIL — `undefined: New`, `undefined: putResponse`, etc.

- [ ] **Step 3: Implement JSON helpers**

`server/internal/httpapi/json.go`:
```go
package httpapi

import (
	"encoding/json"
	"net/http"
)

type errorResponse struct {
	Error          string `json:"error"`
	CurrentVersion *int64 `json:"current_version,omitempty"` // pointer: 0 is a real value
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v) // the client hung up if this fails; nothing to do
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, errorResponse{Error: msg})
}
```

- [ ] **Step 4: Implement the handlers**

`server/internal/httpapi/api.go`:
```go
// Package httpapi exposes the note store over HTTP.
package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"

	"github.com/Mesfrum/flako/server/internal/store"
)

const maxBodyBytes = 1 << 20 // 1 MiB

var noteIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// API holds handler dependencies.
type API struct {
	store  store.Store
	logger *slog.Logger
}

func New(s store.Store, logger *slog.Logger) *API {
	return &API{store: s, logger: logger}
}

// Routes registers the API on mux. More specific patterns win, so "/api/"
// only catches API paths nothing else matched.
func (a *API) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/notes/{id}", a.getNote)
	mux.HandleFunc("PUT /api/notes/{id}", a.putNote)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "no such endpoint")
	})
}

type noteResponse struct {
	Ciphertext string `json:"ciphertext"`
	IV         string `json:"iv"`
	Version    int64  `json:"version"`
	UpdatedAt  int64  `json:"updated_at"`
}

type putRequest struct {
	Ciphertext  string `json:"ciphertext"`
	IV          string `json:"iv"`
	BaseVersion *int64 `json:"base_version"` // pointer so a missing field is detectable
}

type putResponse struct {
	Version   int64 `json:"version"`
	UpdatedAt int64 `json:"updated_at"`
}

func (a *API) getNote(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !noteIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid note id")
		return
	}
	n, err := a.store.GetNote(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "note not found")
		return
	}
	if err != nil {
		a.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, noteResponse{
		Ciphertext: base64.StdEncoding.EncodeToString(n.Ciphertext),
		IV:         base64.StdEncoding.EncodeToString(n.IV),
		Version:    n.Version,
		UpdatedAt:  n.UpdatedAt.UnixMilli(),
	})
}

func (a *API) putNote(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !noteIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid note id")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req putRequest
	if err := dec.Decode(&req); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusRequestEntityTooLarge, "note too large")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	note, err := req.toNote(id)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	saved, err := a.store.PutNote(r.Context(), note, *req.BaseVersion)
	var conflict *store.ConflictError
	if errors.As(err, &conflict) {
		current := conflict.Current
		writeJSON(w, http.StatusConflict, errorResponse{Error: "version conflict", CurrentVersion: &current})
		return
	}
	if err != nil {
		a.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, putResponse{Version: saved.Version, UpdatedAt: saved.UpdatedAt.UnixMilli()})
}

// toNote validates the request. Error messages are safe to show clients.
func (req putRequest) toNote(id string) (store.Note, error) {
	if req.BaseVersion == nil {
		return store.Note{}, errors.New("base_version is required")
	}
	if *req.BaseVersion < 0 {
		return store.Note{}, errors.New("base_version must be >= 0")
	}
	iv, err := base64.StdEncoding.DecodeString(req.IV)
	if err != nil || len(iv) != 12 {
		return store.Note{}, errors.New("iv must be 12 bytes, base64-encoded")
	}
	ct, err := base64.StdEncoding.DecodeString(req.Ciphertext)
	if err != nil || len(ct) < 16 {
		return store.Note{}, errors.New("ciphertext must be at least 16 bytes, base64-encoded")
	}
	return store.Note{ID: id, Ciphertext: ct, IV: iv}, nil
}

func (a *API) internalError(w http.ResponseWriter, r *http.Request, err error) {
	a.logger.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
	writeError(w, http.StatusInternalServerError, "internal error")
}
```

- [ ] **Step 5: Run the tests**

Run: `cd server && gofmt -l . ; go vet ./... && go test ./internal/httpapi/ -v`
Expected: all tests PASS; `gofmt -l` prints nothing.

- [ ] **Step 6: Append to LEARNING.md**

```markdown

## Go: net/http (1.22+ routing)
- `mux.HandleFunc("GET /api/notes/{id}", h)`; read the wildcard with `r.PathValue("id")`.
- Most specific pattern wins: `"/api/"` only gets what `"GET /api/notes/{id}"` didn't match.
- A handler is anything with `ServeHTTP(w, r)`; `http.HandlerFunc(f)` adapts a function.

## Go: JSON
- Struct tags: `json:"base_version"`. `DisallowUnknownFields()` rejects surprises.
- Use a pointer (`*int64`) when "missing" and "zero" must differ.
- Generic helper `decode[T any](...)` — Go has generics since 1.18.

## Go: defensive HTTP
- `http.MaxBytesReader` caps request bodies; detect with `errors.As(err, &*http.MaxBytesError)` → 413.
- Log internal errors, return a generic "internal error" — never leak internals.
- `httptest.NewRecorder()` + `handler.ServeHTTP(rec, req)` tests handlers with no network.
```

- [ ] **Step 7: Commit**

```bash
git add server/internal/httpapi LEARNING.md
git commit -m "feat(server): note GET/PUT API with validation and conflicts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Middleware + main wiring + graceful shutdown

**Concept:** **Middleware** in Go is just `func(http.Handler) http.Handler` — wrap a handler, do something before/after. To learn the status code a handler wrote, wrap the `ResponseWriter` with **struct embedding** (the wrapper inherits all methods, overrides `WriteHeader`). `recover()` inside a deferred function stops a panic from killing the server. `log/slog` gives structured key=value logs. `signal.NotifyContext` returns a `context` that's cancelled on Ctrl+C; `srv.Shutdown(ctx)` stops accepting connections and waits for in-flight requests. **Gotcha:** an `http.Server` without timeouts can be held open forever by slow clients — always set them.

**Files:**
- Create: `server/internal/httpapi/middleware.go`, `server/internal/httpapi/middleware_test.go`, `server/cmd/server/main.go`
- Modify: `LEARNING.md`

**Interfaces:**
- Consumes: `config.Load`, `store.OpenSQLite`, `httpapi.New(...).Routes`.
- Produces: `func Logging(logger *slog.Logger) func(http.Handler) http.Handler`, `func Recover(logger *slog.Logger) func(http.Handler) http.Handler`; a runnable server on `:8080`.

- [ ] **Step 1: Write failing middleware tests**

`server/internal/httpapi/middleware_test.go`:
```go
package httpapi

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newBufferLogger() (*slog.Logger, *bytes.Buffer) {
	var buf bytes.Buffer
	return slog.New(slog.NewTextHandler(&buf, nil)), &buf
}

func TestRecoverTurnsPanicInto500(t *testing.T) {
	logger, logs := newBufferLogger()
	h := Recover(logger)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/x", nil))

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "boom") {
		t.Errorf("panic value leaked to client: %s", rec.Body)
	}
	if !strings.Contains(logs.String(), "boom") {
		t.Errorf("panic not logged; logs: %s", logs)
	}
}

func TestLoggingRecordsStatus(t *testing.T) {
	cases := []struct {
		name    string
		handler http.HandlerFunc
		want    string
	}{
		{"explicit status", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) }, "status=418"},
		{"implicit 200", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("hi")) }, "status=200"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			logger, logs := newBufferLogger()
			Logging(logger)(tc.handler).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/thing", nil))
			if !strings.Contains(logs.String(), tc.want) || !strings.Contains(logs.String(), "path=/thing") {
				t.Errorf("log %q missing %q or path", logs, tc.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && go test ./internal/httpapi/ -run 'Recover|Logging'`
Expected: FAIL — `undefined: Recover`, `undefined: Logging`.

- [ ] **Step 3: Implement middleware**

`server/internal/httpapi/middleware.go`:
```go
package httpapi

import (
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"
)

// statusRecorder embeds http.ResponseWriter (inheriting all its methods) and
// overrides WriteHeader to remember the status code.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// Logging logs one line per request: method, path, status, duration.
func Logging(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r)
			logger.Info("request",
				"method", r.Method,
				"path", r.URL.Path,
				"status", rec.status,
				"duration_ms", time.Since(start).Milliseconds(),
			)
		})
	}
}

// Recover converts a panic in a handler into a 500 so one bad request cannot
// crash the server.
func Recover(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				v := recover()
				if v == nil {
					return
				}
				if v == http.ErrAbortHandler { // deliberate abort: let net/http handle it
					panic(v)
				}
				logger.Error("panic", "path", r.URL.Path, "panic", v, "stack", string(debug.Stack()))
				writeError(w, http.StatusInternalServerError, "internal error")
			}()
			next.ServeHTTP(w, r)
		})
	}
}
```

- [ ] **Step 4: Run middleware tests**

Run: `cd server && go test ./internal/httpapi/ -v -run 'Recover|Logging'`
Expected: PASS.

- [ ] **Step 5: Write main**

`server/cmd/server/main.go`:
```go
// Command server runs the flako HTTP server.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Mesfrum/flako/server/internal/config"
	"github.com/Mesfrum/flako/server/internal/httpapi"
	"github.com/Mesfrum/flako/server/internal/store"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

// run holds the real program so errors flow back as values and deferred
// cleanups (closing the DB) actually execute — os.Exit skips defers.
func run() error {
	cfg := config.Load(os.Getenv)
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))

	// ctx is cancelled on Ctrl+C (SIGINT) or SIGTERM (what Docker/systemd send).
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.OpenSQLite(ctx, cfg.DBPath)
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	mux := http.NewServeMux()
	httpapi.New(st, logger).Routes(mux)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           httpapi.Logging(logger)(httpapi.Recover(logger)(mux)),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second, // revisit in Phase 2: WebSockets are long-lived
		IdleTimeout:       60 * time.Second,
	}

	serveErr := make(chan error, 1)
	go func() {
		logger.Info("listening", "addr", cfg.Addr, "db", cfg.DBPath)
		serveErr <- srv.ListenAndServe()
	}()

	select {
	case err := <-serveErr:
		if !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("serve: %w", err)
		}
	case <-ctx.Done():
		logger.Info("shutting down")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	return nil
}
```

- [ ] **Step 6: Build and smoke-test**

Run: `cd server && gofmt -l . ; go vet ./... && go test ./... && go build -o tmp/server.exe ./cmd/server`
Expected: all packages `ok`; binary builds.

Start it in the background (Bash tool `run_in_background`, or a second terminal): `cd server && ./tmp/server.exe`
Then:
```bash
ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
curl -s localhost:8080/healthz; echo
curl -s localhost:8080/api/notes/$ID; echo
curl -s -X PUT localhost:8080/api/notes/$ID -d '{"ciphertext":"AAAAAAAAAAAAAAAAAAAAAA==","iv":"AAAAAAAAAAAAAAAA","base_version":0}'; echo
curl -s localhost:8080/api/notes/$ID; echo
```
Expected, in order: `ok`; `{"error":"note not found"}`; `{"version":1,"updated_at":...}`; `{"ciphertext":"AAAAAAAAAAAAAAAAAAAAAA==","iv":"AAAAAAAAAAAAAAAA","version":1,...}`. Server log shows one `request ... status=...` line per call and `server/data/notes.db` exists. Stop the server (Ctrl+C in a terminal shows `shutting down`); delete `server/data/` so later manual tests start clean.

- [ ] **Step 7: Append to LEARNING.md**

```markdown

## Go: middleware
- Shape: `func(next http.Handler) http.Handler`. Compose by nesting: `Logging(Recover(mux))` — outermost runs first.
- Struct embedding: `type statusRecorder struct{ http.ResponseWriter; status int }` inherits every method; override just `WriteHeader`.
- `defer func(){ if v := recover(); v != nil {...} }()` catches panics in the same goroutine only.

## Go: context and graceful shutdown
- `context.Context` carries cancellation + deadlines through calls (`r.Context()`, `ctx` params first by convention).
- `signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)` → ctx cancelled on Ctrl+C.
- `srv.Shutdown(ctx)` stops accepting, waits for in-flight requests (up to the ctx deadline).
- `main` → `run() error` pattern: `os.Exit` skips defers, so keep cleanup inside `run`.

## Go gotcha: server timeouts
- The zero `http.Server` has no timeouts — slow clients can hold connections forever. Always set `ReadHeaderTimeout` etc.

## Go: log/slog
- `slog.New(slog.NewTextHandler(os.Stdout, nil)).Info("msg", "key", value, ...)` → `msg=... key=value`.
```

- [ ] **Step 8: Commit**

```bash
git add server LEARNING.md
git commit -m "feat(server): logging/recover middleware, main wiring, graceful shutdown

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Client reset, test setup, encoding + names

**Concept:** **Vitest** runs TypeScript tests with Vite's config; `environment: "node"` is enough because Node 20 ships WebCrypto (`globalThis.crypto`). The Vite dev **proxy** forwards `/api` to Go, so the browser sees one origin — no CORS. **base64url** is base64 with `-_` instead of `+/` and no `=` padding, so it's URL-safe. **Unicode normalization (NFC):** "é" can be one code point or "e" + combining accent; NFC makes them identical bytes, which matters when bytes become keys. **Modulo bias:** `random % n` favours small numbers unless the random range is a multiple of `n`; rejection sampling fixes it.

**Files:**
- Delete: `client/src/App.css`, `client/src/api/`, `client/src/axios.ts`, `client/src/components/`, `client/src/hooks/`, `client/src/layouts/`, `client/src/types/`, `client/src/utils/`, `client/README.md`
- Create: `client/src/crypto/encoding.ts`, `client/src/crypto/encoding.test.ts`, `client/scripts/build-wordlist.mjs`, `client/src/names/wordlist.ts` (generated), `client/src/names/names.ts`, `client/src/names/names.test.ts`
- Modify: `client/package.json`, `client/vite.config.ts`, `client/index.html`, `client/src/index.css`, `client/src/App.tsx`, `client/src/main.tsx`, `LEARNING.md`

**Interfaces:**
- Produces:
  ```ts
  // crypto/encoding.ts
  export function utf8(s: string): Uint8Array
  export function toBase64(bytes: Uint8Array): string
  export function fromBase64(s: string): Uint8Array
  export function toBase64Url(bytes: Uint8Array): string
  // names/names.ts
  export function normalizeName(raw: string): string
  export function randomIndex(n: number): number
  export function generateName(count?: number, words?: readonly string[]): string
  export type StrengthLevel = "weak" | "fair" | "strong"
  export interface Strength { bits: number; level: StrengthLevel; message: string }
  export function estimateStrength(name: string, words?: readonly string[]): Strength
  // names/wordlist.ts
  export const WORDLIST: readonly string[]
  ```

- [ ] **Step 1: Discard the old client code and swap dependencies**

This deletes the uncommitted "Budd" edits too — Phase 4 redoes the UI.
```bash
cd client
git checkout -- index.html src/index.css src/components/Header/Header.tsx src/components/Home/Home.tsx
git rm -r -q src/App.css src/api src/axios.ts src/components src/hooks src/layouts src/types src/utils README.md
npm uninstall axios @tanstack/react-query @tanstack/react-query-devtools lucide-react @tailwindcss/postcss autoprefixer postcss
npm install hash-wasm@^4.12.0
npm install -D vitest@^3.2.4
```

- [ ] **Step 2: Configure scripts, Vite, and the shell files**

In `client/package.json` `"scripts"`, add:
```json
    "test": "vitest run",
    "test:watch": "vitest",
```

`client/vite.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Browser talks only to Vite; Vite forwards API calls to Go. Same origin, no CORS.
    proxy: { "/api": "http://localhost:8080" },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 20_000, // Argon2 derivations take ~0.5s each
  },
});
```

`client/index.html`: change `<title>Vite + React + TS</title>` to `<title>flako</title>` (leave the rest of the restored file as is).

`client/src/index.css` (replace whole file; Tailwind's preflight already resets styles):
```css
@import "tailwindcss";
```

`client/src/App.tsx` (temporary until Task 10):
```tsx
export default function App() {
  return <p className="p-6 font-mono">rebuilding…</p>;
}
```

`client/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
```

Run: `cd client && npx tsc -b && npx vitest run`
Expected: tsc passes; vitest reports "No test files found" (exit code 1 is fine at this point).

- [ ] **Step 3: Write failing encoding tests**

`client/src/crypto/encoding.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fromBase64, toBase64, toBase64Url, utf8 } from "./encoding";

describe("encoding", () => {
  it("round-trips arbitrary bytes through base64", () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it("matches the standard base64 alphabet", () => {
    expect(toBase64(utf8("hello"))).toBe("aGVsbG8=");
    expect(toBase64(new Uint8Array([0xfb, 0xff]))).toBe("+/8=");
  });

  it("produces URL-safe base64 without padding", () => {
    expect(toBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
  });

  it("encodes 32 bytes as a 43-character id", () => {
    expect(toBase64Url(new Uint8Array(32).fill(255))).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("encodes text as UTF-8", () => {
    expect(Array.from(utf8("é"))).toEqual([0xc3, 0xa9]);
  });
});
```

Run: `cd client && npx vitest run src/crypto`
Expected: FAIL — cannot resolve `./encoding`.

- [ ] **Step 4: Implement encoding**

`client/src/crypto/encoding.ts`:
```ts
const encoder = new TextEncoder();

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(s: string): Uint8Array {
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** base64url without padding: safe inside URL paths. */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
```

Run: `cd client && npx vitest run src/crypto`
Expected: PASS (5 tests).

- [ ] **Step 5: Generate the wordlist**

`client/scripts/build-wordlist.mjs`:
```js
// Usage: node scripts/build-wordlist.mjs <eff_large_wordlist.txt> <output.ts>
import { readFileSync, writeFileSync } from "node:fs";

const [, , input, output] = process.argv;
const words = readFileSync(input, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim().split(/\s+/)[1])
  .filter((w) => w && /^[a-z]+$/.test(w)); // drops the 4 hyphenated entries; we join with "-"

if (words.length < 7000) throw new Error(`expected ~7772 words, got ${words.length}`);

writeFileSync(
  output,
  `// Generated by scripts/build-wordlist.mjs from the EFF large wordlist\n` +
    `// (https://www.eff.org/dice, CC BY 3.0 US). Do not edit by hand.\n` +
    `export const WORDLIST: readonly string[] = ${JSON.stringify(words)};\n`,
);
console.log(`wrote ${words.length} words to ${output}`);
```

Run:
```bash
cd client
curl -fsSL https://www.eff.org/files/2016/07/18/eff_large_wordlist.txt -o eff_large_wordlist.txt
node scripts/build-wordlist.mjs eff_large_wordlist.txt src/names/wordlist.ts
rm eff_large_wordlist.txt
```
Expected: `wrote 7772 words to src/names/wordlist.ts`.

- [ ] **Step 6: Write failing names tests**

`client/src/names/names.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { estimateStrength, generateName, normalizeName, randomIndex } from "./names";
import { WORDLIST } from "./wordlist";

describe("normalizeName", () => {
  it("trims and lowercases", () => {
    expect(normalizeName("  Taco ")).toBe("taco");
  });

  it("treats composed and decomposed accents as the same name", () => {
    expect(normalizeName("Café")).toBe(normalizeName("Café"));
  });

  it("keeps inner spaces and slashes (they are part of the name)", () => {
    expect(normalizeName(" My Notes/Work ")).toBe("my notes/work");
  });

  it("returns empty for blank input", () => {
    expect(normalizeName("   ")).toBe("");
  });
});

describe("randomIndex", () => {
  it("stays within [0, n)", () => {
    for (let i = 0; i < 1000; i++) {
      const v = randomIndex(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
    expect(randomIndex(1)).toBe(0);
  });
});

describe("generateName", () => {
  it("joins four wordlist words with dashes", () => {
    const parts = generateName().split("-");
    expect(parts).toHaveLength(4);
    for (const p of parts) expect(WORDLIST).toContain(p);
  });

  it("does not repeat itself", () => {
    const names = new Set(Array.from({ length: 50 }, () => generateName()));
    expect(names.size).toBe(50);
  });
});

describe("estimateStrength", () => {
  it("calls short dictionary-ish names weak", () => {
    expect(estimateStrength("taco").level).toBe("weak");
  });

  it("calls generated names strong", () => {
    const s = estimateStrength(generateName());
    expect(s.level).toBe("strong");
    expect(s.bits).toBeGreaterThanOrEqual(50);
  });

  it("scores wordlist names by word count, not characters", () => {
    // two long words are still only two guesses-from-a-list
    expect(estimateStrength(`${WORDLIST[0]}-${WORDLIST[1]}`).level).toBe("weak");
  });

  it("gives a human-readable message", () => {
    expect(estimateStrength("taco").message.length).toBeGreaterThan(0);
  });
});
```

Run: `cd client && npx vitest run src/names`
Expected: FAIL — cannot resolve `./names`.

- [ ] **Step 7: Implement names**

`client/src/names/names.ts`:
```ts
import { WORDLIST } from "./wordlist";

/** Canonical form of a note name. Equal names → equal keys, so this must be stable forever. */
export function normalizeName(raw: string): string {
  return raw.normalize("NFC").trim().toLowerCase();
}

/** Uniform random integer in [0, n), without modulo bias. */
export function randomIndex(n: number): number {
  const range = 0x1_0000_0000; // 2^32 possible Uint32 values
  const limit = range - (range % n); // largest multiple of n that fits
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return buf[0] % n;
}

export function generateName(count = 4, words: readonly string[] = WORDLIST): string {
  return Array.from({ length: count }, () => words[randomIndex(words.length)]).join("-");
}

export type StrengthLevel = "weak" | "fair" | "strong";

export interface Strength {
  bits: number;
  level: StrengthLevel;
  message: string;
}

const MESSAGES: Record<StrengthLevel, string> = {
  weak: "weak name: someone guessing common words could open this note",
  fair: "fair name: hard to stumble on, not hard to brute-force",
  strong: "strong name: practically unguessable",
};

const DEFAULT_WORDSET = new Set(WORDLIST);

/** Rough entropy estimate in bits. Deliberately pessimistic about wordlist names. */
export function estimateStrength(name: string, words: readonly string[] = WORDLIST): Strength {
  const bits = estimateBits(name, words);
  const level: StrengthLevel = bits < 35 ? "weak" : bits < 50 ? "fair" : "strong";
  return { bits: Math.round(bits), level, message: MESSAGES[level] };
}

function estimateBits(name: string, words: readonly string[]): number {
  const wordset = words === WORDLIST ? DEFAULT_WORDSET : new Set(words);
  const parts = name.split("-");
  if (parts.length >= 2 && parts.every((p) => wordset.has(p))) {
    return parts.length * Math.log2(words.length);
  }
  let pool = 0;
  if (/[a-z]/.test(name)) pool += 26;
  if (/[0-9]/.test(name)) pool += 10;
  if (/[^a-z0-9]/.test(name)) pool += 33;
  return pool === 0 ? 0 : name.length * Math.log2(pool);
}
```

- [ ] **Step 8: Run all client checks**

Run: `cd client && npx vitest run && npx tsc -b && npm run lint`
Expected: all tests PASS; tsc and eslint clean.

- [ ] **Step 9: Append to LEARNING.md**

```markdown

## Web: base64 vs base64url
- base64 uses `+ / =`, which mean things in URLs. base64url swaps to `- _` and drops `=`.
- 32 bytes → 43 base64url chars: that's our note id.

## Unicode: NFC normalization
- "é" can be U+00E9 or "e" + U+0301. They look identical but are different bytes → different keys!
- `s.normalize("NFC")` makes them identical. Anything that feeds a hash/KDF must be normalized first.

## Crypto: modulo bias
- `randomUint32 % n` slightly favours small results unless 2^32 is a multiple of n.
- Fix: reject values ≥ the largest multiple of n below 2^32, draw again (rejection sampling).

## Crypto: passphrase entropy
- 4 words from 7772 → 4 × log2(7772) ≈ 51.7 bits. Each bit doubles an attacker's work.
- Length alone lies: "correcthorse" is 2 dictionary words, not 12 random letters.

## Tooling: Vite proxy + Vitest
- `server.proxy: { "/api": "http://localhost:8080" }` — dev browser sees one origin, so no CORS.
- Vitest reuses the Vite config; `environment: "node"` works because Node 20 has WebCrypto built in.
```

- [ ] **Step 10: Commit**

```bash
git add -A client LEARNING.md
git commit -m "refactor(client): strip old app; add vitest, encoding and name utilities

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Key derivation + encryption

**Concept:** A **KDF** turns a secret into keys. **Argon2id** is a *slow, memory-hard* password hash: each guess costs ~0.5s and 64 MB, so attackers with GPUs can't try billions per second like they can with SHA-256. **HKDF** is a *fast* KDF that splits one strong secret into independent sub-keys via different `info` labels. **AES-GCM** encrypts *and authenticates*: any changed byte makes decryption fail. Its **IV must never repeat with the same key** — reuse leaks the XOR of two plaintexts and breaks authentication — so we draw a fresh random 12-byte IV per save. **AAD** (additional authenticated data) is checked but not encrypted: binding the note id means a blob copied to another note fails to decrypt. A **known-answer test** freezes the derivation: if anyone changes a parameter, every existing note would become unreadable, so the test must fail loudly.

**Files:**
- Create: `client/src/crypto/derive.ts`, `client/src/crypto/derive.test.ts`, `client/src/crypto/cipher.ts`, `client/src/crypto/cipher.test.ts`
- Modify: `LEARNING.md`

**Interfaces:**
- Consumes: `utf8`, `toBase64Url` from `crypto/encoding.ts`.
- Produces:
  ```ts
  // crypto/derive.ts
  export const KDF_PARAMS: { salt: "flako/v1"; memorySize: 65536; iterations: 3; parallelism: 1; hashLength: 32 }
  export interface NoteKeys { id: string; key: CryptoKey }
  export function deriveNoteKeys(normalizedName: string): Promise<NoteKeys>
  // crypto/cipher.ts
  export interface EncryptedNote { ciphertext: Uint8Array; iv: Uint8Array }
  export class DecryptError extends Error
  export function encryptNote(key: CryptoKey, noteId: string, text: string): Promise<EncryptedNote>
  export function decryptNote(key: CryptoKey, noteId: string, enc: EncryptedNote): Promise<string>
  ```

- [ ] **Step 1: Write failing cipher tests**

`client/src/crypto/cipher.test.ts`:
```ts
import { beforeAll, describe, expect, it } from "vitest";
import { DecryptError, decryptNote, encryptNote } from "./cipher";

const ID = "a".repeat(43);
let key: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  const gen = () =>
    crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  key = await gen();
  otherKey = await gen();
});

describe("encryptNote / decryptNote", () => {
  it.each(["hello", "", "émoji 🌮 and\nnewlines"])("round-trips %j", async (text) => {
    const enc = await encryptNote(key, ID, text);
    expect(await decryptNote(key, ID, enc)).toBe(text);
  });

  it("uses a fresh 12-byte IV every time", async () => {
    const a = await encryptNote(key, ID, "same");
    const b = await encryptNote(key, ID, "same");
    expect(a.iv).toHaveLength(12);
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it("encrypts an empty note to at least 16 bytes (the server minimum)", async () => {
    const enc = await encryptNote(key, ID, "");
    expect(enc.ciphertext.length).toBeGreaterThanOrEqual(16);
  });

  it("rejects a tampered ciphertext", async () => {
    const enc = await encryptNote(key, ID, "secret");
    enc.ciphertext[0] ^= 1;
    await expect(decryptNote(key, ID, enc)).rejects.toBeInstanceOf(DecryptError);
  });

  it("rejects a different IV", async () => {
    const enc = await encryptNote(key, ID, "secret");
    enc.iv[0] ^= 1;
    await expect(decryptNote(key, ID, enc)).rejects.toBeInstanceOf(DecryptError);
  });

  it("rejects a blob moved to another note id (AAD binding)", async () => {
    const enc = await encryptNote(key, ID, "secret");
    await expect(decryptNote(key, "b".repeat(43), enc)).rejects.toBeInstanceOf(DecryptError);
  });

  it("rejects the wrong key", async () => {
    const enc = await encryptNote(key, ID, "secret");
    await expect(decryptNote(otherKey, ID, enc)).rejects.toBeInstanceOf(DecryptError);
  });

  it("rejects a payload that decrypts but is not our format", async () => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(ID) },
      key,
      new TextEncoder().encode('{"v":2,"text":"future"}'),
    );
    await expect(decryptNote(key, ID, { iv, ciphertext: new Uint8Array(ct) })).rejects.toBeInstanceOf(
      DecryptError,
    );
  });
});
```

Run: `cd client && npx vitest run src/crypto/cipher`
Expected: FAIL — cannot resolve `./cipher`.

- [ ] **Step 2: Implement cipher**

`client/src/crypto/cipher.ts`:
```ts
import { utf8 } from "./encoding";

export interface EncryptedNote {
  ciphertext: Uint8Array;
  iv: Uint8Array;
}

/** Any failure to turn ciphertext back into a note: wrong key, tampering, unknown format. */
export class DecryptError extends Error {
  constructor(message = "note could not be decrypted") {
    super(message);
    this.name = "DecryptError";
  }
}

interface PlaintextV1 {
  v: 1;
  text: string;
}

const decoder = new TextDecoder();

export async function encryptNote(key: CryptoKey, noteId: string, text: string): Promise<EncryptedNote> {
  // NEVER reuse an IV with the same key. Random 96-bit IVs are safe for far more saves than we'll ever do.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload: PlaintextV1 = { v: 1, text };
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8(noteId) },
    key,
    utf8(JSON.stringify(payload)),
  );
  return { ciphertext: new Uint8Array(ciphertext), iv };
}

export async function decryptNote(key: CryptoKey, noteId: string, enc: EncryptedNote): Promise<string> {
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: enc.iv, additionalData: utf8(noteId) },
      key,
      enc.ciphertext,
    );
  } catch {
    throw new DecryptError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(plain));
  } catch {
    throw new DecryptError("note payload is not valid JSON");
  }
  if (!isPlaintextV1(parsed)) throw new DecryptError("unsupported note format");
  return parsed.text;
}

function isPlaintextV1(v: unknown): v is PlaintextV1 {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { v?: unknown }).v === 1 &&
    typeof (v as { text?: unknown }).text === "string"
  );
}
```

Run: `cd client && npx vitest run src/crypto/cipher`
Expected: PASS.

- [ ] **Step 3: Write failing derive tests**

`client/src/crypto/derive.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { decryptNote, DecryptError, encryptNote } from "./cipher";
import { deriveNoteKeys, KDF_PARAMS } from "./derive";

describe("deriveNoteKeys", () => {
  it("pins the KDF parameters — changing them orphans every existing note", () => {
    expect(KDF_PARAMS).toEqual({
      salt: "flako/v1",
      memorySize: 65536,
      iterations: 3,
      parallelism: 1,
      hashLength: 32,
    });
  });

  it("matches known answers (computed once, frozen forever)", async () => {
    expect((await deriveNoteKeys("taco")).id).toBe("DqMCETSlWMyiBEuz-TOWLYfWY4EYFz8GGBMm0p3Xl1M");
    expect((await deriveNoteKeys("velvet-anchor-mutters-softly")).id).toBe(
      "hwzWX5YnQyJukfK1YDpSa7y3DJZUqq5E8AdjYFThQ-o",
    );
  });

  it("derives the same id and a compatible key for the same name", async () => {
    const a = await deriveNoteKeys("same-name");
    const b = await deriveNoteKeys("same-name");
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const enc = await encryptNote(a.key, a.id, "hi");
    expect(await decryptNote(b.key, b.id, enc)).toBe("hi");
  });

  it("derives unrelated keys for different names", async () => {
    const a = await deriveNoteKeys("name-one");
    const b = await deriveNoteKeys("name-two");
    expect(a.id).not.toBe(b.id);
    const enc = await encryptNote(a.key, a.id, "hi");
    await expect(decryptNote(b.key, a.id, enc)).rejects.toBeInstanceOf(DecryptError);
  });

  it("produces a non-extractable key", async () => {
    const { key } = await deriveNoteKeys("taco");
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });
});
```

Run: `cd client && npx vitest run src/crypto/derive`
Expected: FAIL — cannot resolve `./derive`.

- [ ] **Step 4: Implement derive**

`client/src/crypto/derive.ts`:
```ts
import { argon2id } from "hash-wasm";
import { toBase64Url, utf8 } from "./encoding";

/**
 * Frozen forever: changing ANY of these makes every existing note unreadable.
 * The salt is app-wide (it must be — two people typing the same name need the
 * same key), so security rests on Argon2's cost and on the name's strength.
 */
export const KDF_PARAMS = {
  salt: "flako/v1",
  memorySize: 65536, // KiB = 64 MiB
  iterations: 3,
  parallelism: 1,
  hashLength: 32,
} as const;

export interface NoteKeys {
  /** base64url(HKDF(master, "id")) — the only thing the server ever sees. */
  id: string;
  /** AES-256-GCM key; non-extractable, never leaves this browser tab. */
  key: CryptoKey;
}

/** Expects an already-normalized name (see names/normalizeName). Takes ~0.5s on purpose. */
export async function deriveNoteKeys(normalizedName: string): Promise<NoteKeys> {
  const master = await argon2id({
    password: normalizedName,
    salt: KDF_PARAMS.salt,
    memorySize: KDF_PARAMS.memorySize,
    iterations: KDF_PARAMS.iterations,
    parallelism: KDF_PARAMS.parallelism,
    hashLength: KDF_PARAMS.hashLength,
    outputType: "binary",
  });

  const hkdfKey = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveBits", "deriveKey"]);
  const hkdf = (info: string): HkdfParams => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(0),
    info: utf8(info),
  });

  const idBits = await crypto.subtle.deriveBits(hkdf("flako/v1/id"), hkdfKey, 256);
  const key = await crypto.subtle.deriveKey(
    hkdf("flako/v1/enc"),
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  return { id: toBase64Url(new Uint8Array(idBits)), key };
}
```

- [ ] **Step 5: Run all client checks**

Run: `cd client && npx vitest run && npx tsc -b && npm run lint`
Expected: all PASS, including the known-answer test.

- [ ] **Step 6: Append to LEARNING.md**

```markdown

## Crypto: slow vs fast hashes
- SHA-256 is built to be fast: billions of guesses/second on a GPU. Terrible for passwords.
- Argon2id is built to be slow AND memory-hungry (64 MB per guess here), so GPUs barely help.
- Our names are passwords; "taco" is still weak — slowness only buys time per guess.

## Crypto: HKDF
- Fast way to split one strong secret into many independent keys using different `info` labels.
- Knowing the derived id ("flako/v1/id") reveals nothing about the encryption key ("flako/v1/enc").

## Crypto: AES-GCM, IVs, AAD
- GCM = encryption + authentication tag (16 bytes). Any flipped bit → decrypt fails.
- IV (nonce) must never repeat under one key: reuse leaks plaintext XORs and lets attackers forge.
  We draw 12 random bytes per save.
- AAD: authenticated but not encrypted. We put the note id there, so blobs can't be swapped between notes.

## Crypto: known-answer tests
- Derivation must never change, or every note becomes unreadable. A test with a hard-coded expected
  output (computed once) catches accidental changes to salt, params, or info strings.

## Web: WebCrypto
- `crypto.subtle` is async and keeps keys inside the browser; `extractable: false` means even our own JS can't read the raw key.
```

- [ ] **Step 7: Commit**

```bash
git add client/src/crypto LEARNING.md
git commit -m "feat(client): Argon2id+HKDF key derivation and AES-GCM note encryption

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Notes API client + pending store

**Concept:** Wrapping `fetch` in a tiny module turns HTTP status codes into **typed errors** (`ConflictError`, `TooLargeError`, `NetworkError`, `HttpError`), so callers use `instanceof` instead of remembering numbers. `fetch` only rejects on *network* failure; a 500 is a *successful* fetch with `res.ok === false`. **Dependency injection** again: the API takes a `fetch` function and the pending store takes a `Storage`-like object, so tests pass fakes. The pending store holds **only ciphertext** — localStorage is readable by anything running on the page.

**Files:**
- Create: `client/src/notes/api.ts`, `client/src/notes/api.test.ts`, `client/src/notes/pending.ts`, `client/src/notes/pending.test.ts`
- Modify: `LEARNING.md`

**Interfaces:**
- Consumes: `toBase64`, `fromBase64`; `EncryptedNote`.
- Produces:
  ```ts
  // notes/api.ts
  export interface RemoteNote extends EncryptedNote { version: number; updatedAt: number }
  export interface SaveResult { version: number; updatedAt: number }
  export interface NotesApi {
    getNote(id: string): Promise<RemoteNote | null>;
    putNote(id: string, encrypted: EncryptedNote, baseVersion: number): Promise<SaveResult>;
  }
  export class NetworkError extends Error
  export class HttpError extends Error { readonly status: number }
  export class ConflictError extends Error { readonly currentVersion: number }
  export class TooLargeError extends Error
  export function isRetryable(err: unknown): boolean
  export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>
  export function createNotesApi(fetchFn?: FetchFn, baseUrl?: string): NotesApi
  // notes/pending.ts
  export interface PendingSave { encrypted: EncryptedNote; baseVersion: number }
  export interface PendingStore { load(id: string): PendingSave | null; save(id: string, p: PendingSave): void; clear(id: string): void }
  export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">
  export function createPendingStore(storage: KeyValueStorage): PendingStore
  export function memoryStorage(): KeyValueStorage
  ```

- [ ] **Step 1: Write failing API tests**

`client/src/notes/api.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { toBase64 } from "../crypto/encoding";
import {
  ConflictError,
  createNotesApi,
  HttpError,
  isRetryable,
  NetworkError,
  TooLargeError,
  type FetchFn,
} from "./api";

const ID = "a".repeat(43);
const enc = { ciphertext: new Uint8Array(16).fill(1), iv: new Uint8Array(12).fill(2) };

function fakeFetch(respond: () => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { fn, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("getNote", () => {
  it("decodes a stored note", async () => {
    const { fn, calls } = fakeFetch(() =>
      json(200, { ciphertext: toBase64(enc.ciphertext), iv: toBase64(enc.iv), version: 3, updated_at: 99 }),
    );
    const note = await createNotesApi(fn).getNote(ID);
    expect(calls[0].url).toBe(`/api/notes/${ID}`);
    expect(note).toEqual({ ...enc, version: 3, updatedAt: 99 });
  });

  it("returns null for 404", async () => {
    const { fn } = fakeFetch(() => json(404, { error: "note not found" }));
    expect(await createNotesApi(fn).getNote(ID)).toBeNull();
  });

  it("throws HttpError for 500", async () => {
    const { fn } = fakeFetch(() => json(500, { error: "internal error" }));
    await expect(createNotesApi(fn).getNote(ID)).rejects.toMatchObject({ status: 500 });
  });
});

describe("putNote", () => {
  it("sends base64 body with base_version and returns the new version", async () => {
    const { fn, calls } = fakeFetch(() => json(200, { version: 4, updated_at: 123 }));
    const res = await createNotesApi(fn).putNote(ID, enc, 3);
    expect(res).toEqual({ version: 4, updatedAt: 123 });
    expect(calls[0].init?.method).toBe("PUT");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      ciphertext: toBase64(enc.ciphertext),
      iv: toBase64(enc.iv),
      base_version: 3,
    });
  });

  it("maps 409 to ConflictError with the server's version", async () => {
    const { fn } = fakeFetch(() => json(409, { error: "version conflict", current_version: 7 }));
    const err = await createNotesApi(fn).putNote(ID, enc, 3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).currentVersion).toBe(7);
  });

  it("maps 413 to TooLargeError", async () => {
    const { fn } = fakeFetch(() => json(413, { error: "note too large" }));
    await expect(createNotesApi(fn).putNote(ID, enc, 0)).rejects.toBeInstanceOf(TooLargeError);
  });

  it("maps a thrown fetch to NetworkError", async () => {
    const fn: FetchFn = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(createNotesApi(fn).putNote(ID, enc, 0)).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("isRetryable", () => {
  it("retries network errors and 5xx only", () => {
    expect(isRetryable(new NetworkError())).toBe(true);
    expect(isRetryable(new HttpError(503))).toBe(true);
    expect(isRetryable(new HttpError(400))).toBe(false);
    expect(isRetryable(new ConflictError(1))).toBe(false);
    expect(isRetryable(new TooLargeError())).toBe(false);
  });
});
```

Run: `cd client && npx vitest run src/notes/api`
Expected: FAIL — cannot resolve `./api`.

- [ ] **Step 2: Implement the API client**

`client/src/notes/api.ts`:
```ts
import type { EncryptedNote } from "../crypto/cipher";
import { fromBase64, toBase64 } from "../crypto/encoding";

export interface RemoteNote extends EncryptedNote {
  version: number;
  updatedAt: number;
}

export interface SaveResult {
  version: number;
  updatedAt: number;
}

export interface NotesApi {
  getNote(id: string): Promise<RemoteNote | null>;
  putNote(id: string, encrypted: EncryptedNote, baseVersion: number): Promise<SaveResult>;
}

export class NetworkError extends Error {
  constructor() {
    super("network request failed");
    this.name = "NetworkError";
  }
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`server responded ${status}`);
    this.name = "HttpError";
    this.status = status;
  }
}

export class ConflictError extends Error {
  readonly currentVersion: number;
  constructor(currentVersion: number) {
    super(`version conflict (server is at ${currentVersion})`);
    this.name = "ConflictError";
    this.currentVersion = currentVersion;
  }
}

export class TooLargeError extends Error {
  constructor() {
    super("note too large");
    this.name = "TooLargeError";
  }
}

/** Worth trying again later: the network or the server hiccupped, not our request. */
export function isRetryable(err: unknown): boolean {
  return err instanceof NetworkError || (err instanceof HttpError && err.status >= 500);
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

interface NoteBody {
  ciphertext: string;
  iv: string;
  version: number;
  updated_at: number;
}

export function createNotesApi(
  fetchFn: FetchFn = (input, init) => fetch(input, init),
  baseUrl = "/api",
): NotesApi {
  async function send(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetchFn(`${baseUrl}${path}`, init);
    } catch {
      throw new NetworkError(); // fetch only rejects when no HTTP response arrived at all
    }
  }

  return {
    async getNote(id) {
      const res = await send(`/notes/${id}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new HttpError(res.status);
      const body = (await res.json()) as NoteBody;
      return {
        ciphertext: fromBase64(body.ciphertext),
        iv: fromBase64(body.iv),
        version: body.version,
        updatedAt: body.updated_at,
      };
    },

    async putNote(id, encrypted, baseVersion) {
      const res = await send(`/notes/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ciphertext: toBase64(encrypted.ciphertext),
          iv: toBase64(encrypted.iv),
          base_version: baseVersion,
        }),
      });
      if (res.status === 409) {
        const body = (await res.json()) as { current_version: number };
        throw new ConflictError(body.current_version);
      }
      if (res.status === 413) throw new TooLargeError();
      if (!res.ok) throw new HttpError(res.status);
      const body = (await res.json()) as { version: number; updated_at: number };
      return { version: body.version, updatedAt: body.updated_at };
    },
  };
}
```

Run: `cd client && npx vitest run src/notes/api`
Expected: PASS.

- [ ] **Step 3: Write failing pending-store tests**

`client/src/notes/pending.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createPendingStore, memoryStorage } from "./pending";

const ID = "a".repeat(43);
const save = {
  encrypted: { ciphertext: new Uint8Array([1, 2, 3, 4]), iv: new Uint8Array(12).fill(9) },
  baseVersion: 5,
};

describe("pending store", () => {
  it("round-trips a pending save", () => {
    const store = createPendingStore(memoryStorage());
    store.save(ID, save);
    expect(store.load(ID)).toEqual(save);
  });

  it("returns null when nothing is pending", () => {
    expect(createPendingStore(memoryStorage()).load(ID)).toBeNull();
  });

  it("clears", () => {
    const store = createPendingStore(memoryStorage());
    store.save(ID, save);
    store.clear(ID);
    expect(store.load(ID)).toBeNull();
  });

  it("ignores corrupt entries", () => {
    const storage = memoryStorage();
    storage.setItem(`pending:${ID}`, "{not json");
    expect(createPendingStore(storage).load(ID)).toBeNull();
    storage.setItem(`pending:${ID}`, JSON.stringify({ ciphertext: 1 }));
    expect(createPendingStore(storage).load(ID)).toBeNull();
  });

  it("stores only base64 ciphertext, iv and version under pending:<id>", () => {
    const storage = memoryStorage();
    createPendingStore(storage).save(ID, save);
    expect(JSON.parse(storage.getItem(`pending:${ID}`)!)).toEqual({
      ciphertext: "AQIDBA==",
      iv: "CQkJCQkJCQkJCQkJ",
      baseVersion: 5,
    });
  });
});
```

Run: `cd client && npx vitest run src/notes/pending`
Expected: FAIL — cannot resolve `./pending`.

- [ ] **Step 4: Implement the pending store**

`client/src/notes/pending.ts`:
```ts
import type { EncryptedNote } from "../crypto/cipher";
import { fromBase64, toBase64 } from "../crypto/encoding";

/** A save that has not reached the server yet. Ciphertext only — never plaintext. */
export interface PendingSave {
  encrypted: EncryptedNote;
  baseVersion: number;
}

export interface PendingStore {
  load(id: string): PendingSave | null;
  save(id: string, pending: PendingSave): void;
  clear(id: string): void;
}

export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

interface StoredPending {
  ciphertext: string;
  iv: string;
  baseVersion: number;
}

const keyFor = (id: string) => `pending:${id}`;

export function createPendingStore(storage: KeyValueStorage): PendingStore {
  return {
    load(id) {
      const raw = storage.getItem(keyFor(id));
      if (!raw) return null;
      try {
        const p = JSON.parse(raw) as Partial<StoredPending>;
        if (typeof p.ciphertext !== "string" || typeof p.iv !== "string" || typeof p.baseVersion !== "number") {
          return null;
        }
        return {
          encrypted: { ciphertext: fromBase64(p.ciphertext), iv: fromBase64(p.iv) },
          baseVersion: p.baseVersion,
        };
      } catch {
        return null;
      }
    },

    save(id, pending) {
      const stored: StoredPending = {
        ciphertext: toBase64(pending.encrypted.ciphertext),
        iv: toBase64(pending.encrypted.iv),
        baseVersion: pending.baseVersion,
      };
      try {
        storage.setItem(keyFor(id), JSON.stringify(stored));
      } catch {
        // Quota exceeded or storage disabled: the "unsaved" status already warns the user.
      }
    },

    clear(id) {
      storage.removeItem(keyFor(id));
    },
  };
}

/** In-memory Storage stand-in for tests (and environments without localStorage). */
export function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}
```

- [ ] **Step 5: Run all client checks**

Run: `cd client && npx vitest run && npx tsc -b && npm run lint`
Expected: all PASS.

- [ ] **Step 6: Append to LEARNING.md**

```markdown

## Web: fetch semantics
- `fetch` rejects ONLY when no response arrives (offline, DNS, CORS). A 500 resolves with `res.ok === false`.
- Turn statuses into typed errors once (`ConflictError`, `TooLargeError`...) and use `instanceof` everywhere else.

## Security: what goes in localStorage
- Any script on the page can read localStorage. We store pending saves as ciphertext only, so a leak reveals nothing.
```

- [ ] **Step 7: Commit**

```bash
git add client/src/notes LEARNING.md
git commit -m "feat(client): typed notes API client and ciphertext-only pending store

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: NoteSync state machine

**Concept:** Keep tricky logic **out of React**: `NoteSync` is a plain class with explicit states (`deriving → loading → ready | unreadable | error`; within `ready`, a save state `clean | dirty | saving | unsaved | conflict | tooLarge`). React later just subscribes. **Debouncing** waits until typing pauses. **Single-flight**: only one PUT at a time; edits made meanwhile set `dirty` and trigger one follow-up save. A **run counter** invalidates stale async work — React StrictMode mounts, unmounts and remounts effects in dev, so an old `start()` must not clobber a new one. **Exponential backoff** (1s, 2s, 4s … 30s) avoids hammering a down server. Tests use **fake timers** for `setTimeout`, while real WebCrypto runs on Node's thread pool — so tests wait with `until()`, which yields via the real `setImmediate`.

**Files:**
- Create: `client/src/notes/noteSync.ts`, `client/src/notes/noteSync.test.ts`
- Modify: `LEARNING.md`

**Interfaces:**
- Consumes: `NoteKeys`; `encryptNote`, `decryptNote`, `DecryptError`; `NotesApi`, `RemoteNote`, `ConflictError`, `TooLargeError`, `NetworkError`, `isRetryable`; `PendingStore`, `createPendingStore`, `memoryStorage`.
- Produces:
  ```ts
  export type SaveState =
    | { kind: "clean"; savedAt: number | null } | { kind: "dirty" } | { kind: "saving" }
    | { kind: "unsaved"; retryInMs: number } | { kind: "conflict" } | { kind: "tooLarge" };
  export type NoteStatus =
    | { kind: "deriving" } | { kind: "loading" } | { kind: "ready"; save: SaveState }
    | { kind: "unreadable" } | { kind: "error"; message: string };
  export interface NoteSnapshot { status: NoteStatus; text: string }
  export interface NoteSyncDeps { api: NotesApi; pending: PendingStore; derive: (name: string) => Promise<NoteKeys>; debounceMs?: number }
  export class NoteSync {
    constructor(name: string, deps: NoteSyncDeps)
    subscribe: (listener: () => void) => () => void
    getSnapshot: () => NoteSnapshot
    start(): Promise<void>
    setText: (text: string) => void
    resolveConflict: (choice: "theirs" | "mine") => Promise<void>
    retryNow: () => void
    dispose(): void
  }
  ```

- [ ] **Step 1: Write the failing tests**

`client/src/notes/noteSync.test.ts`:
```ts
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptNote, encryptNote, type EncryptedNote } from "../crypto/cipher";
import { ConflictError, NetworkError, TooLargeError, type NotesApi, type RemoteNote } from "./api";
import { NoteSync } from "./noteSync";
import { createPendingStore, memoryStorage } from "./pending";

const ID = "a".repeat(43);
let key: CryptoKey;

beforeAll(async () => {
  key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
});
// Fake only timers; setImmediate stays real so `until` can wait for WebCrypto.
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => vi.useRealTimers());

/** In-memory server with the same version rules as the Go store. */
class FakeApi implements NotesApi {
  notes = new Map<string, RemoteNote>();
  putCalls = 0;
  failures: Error[] = []; // thrown by the next putNote calls, in order
  gate: Promise<void> | null = null; // while set, putNote waits on it
  private clock = 1000;

  async getNote(id: string): Promise<RemoteNote | null> {
    const n = this.notes.get(id);
    return n ? { ...n } : null;
  }

  async putNote(id: string, encrypted: EncryptedNote, baseVersion: number) {
    this.putCalls++;
    if (this.gate) await this.gate;
    const failure = this.failures.shift();
    if (failure) throw failure;
    const current = this.notes.get(id)?.version ?? 0;
    if (current !== baseVersion) throw new ConflictError(current);
    const stored = { ...encrypted, version: current + 1, updatedAt: ++this.clock };
    this.notes.set(id, stored);
    return { version: stored.version, updatedAt: stored.updatedAt };
  }
}

function setup() {
  const api = new FakeApi();
  const storage = memoryStorage();
  const pending = createPendingStore(storage);
  const sync = new NoteSync("any-name", { api, pending, derive: async () => ({ id: ID, key }), debounceMs: 1000 });
  return { api, storage, pending, sync };
}

async function seedRemote(api: FakeApi, text: string, version = 1) {
  api.notes.set(ID, { ...(await encryptNote(key, ID, text)), version, updatedAt: 500 });
}

const remoteText = (api: FakeApi) => decryptNote(key, ID, api.notes.get(ID)!);

/** "ready:<saveKind>" or the top-level status kind. */
function state(sync: NoteSync): string {
  const s = sync.getSnapshot().status;
  return s.kind === "ready" ? `ready:${s.save.kind}` : s.kind;
}

async function until(predicate: () => boolean, what: string) {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("loading", () => {
  it("opens a brand-new note as empty and clean", async () => {
    const { sync } = setup();
    await sync.start();
    expect(sync.getSnapshot()).toEqual({ text: "", status: { kind: "ready", save: { kind: "clean", savedAt: null } } });
  });

  it("decrypts an existing note", async () => {
    const { api, sync } = setup();
    await seedRemote(api, "hello");
    await sync.start();
    expect(sync.getSnapshot()).toEqual({ text: "hello", status: { kind: "ready", save: { kind: "clean", savedAt: 500 } } });
  });

  it("marks an undecryptable note unreadable and refuses edits", async () => {
    const { api, sync } = setup();
    api.notes.set(ID, { ciphertext: new Uint8Array(32), iv: new Uint8Array(12), version: 1, updatedAt: 1 });
    await sync.start();
    expect(state(sync)).toBe("unreadable");
    sync.setText("overwrite attempt");
    vi.advanceTimersByTime(5000);
    expect(api.putCalls).toBe(0);
  });

  it("notifies subscribers on change", async () => {
    const { sync } = setup();
    const listener = vi.fn();
    sync.subscribe(listener);
    await sync.start();
    expect(listener).toHaveBeenCalled();
  });
});

describe("autosave", () => {
  it("debounces and saves the latest text once", async () => {
    const { api, sync } = setup();
    await sync.start();
    sync.setText("a");
    sync.setText("ab");
    expect(state(sync)).toBe("ready:dirty");
    vi.advanceTimersByTime(999);
    expect(api.putCalls).toBe(0);
    vi.advanceTimersByTime(1);
    await until(() => state(sync) === "ready:clean", "clean");
    expect(api.putCalls).toBe(1);
    expect(await remoteText(api)).toBe("ab");
  });

  it("saves an emptied note", async () => {
    const { api, sync } = setup();
    await seedRemote(api, "something");
    await sync.start();
    sync.setText("");
    vi.advanceTimersByTime(1000);
    await until(() => state(sync) === "ready:clean", "clean");
    expect(await remoteText(api)).toBe("");
    expect(api.notes.get(ID)!.version).toBe(2);
  });

  it("keeps edits made while a save is in flight", async () => {
    const { api, sync } = setup();
    await sync.start();
    let release!: () => void;
    api.gate = new Promise((r) => (release = r));
    sync.setText("one");
    vi.advanceTimersByTime(1000);
    await until(() => api.putCalls === 1, "first PUT");
    sync.setText("one two");
    expect(state(sync)).toBe("ready:saving");
    api.gate = null;
    release();
    await until(() => state(sync) === "ready:dirty", "follow-up queued");
    vi.advanceTimersByTime(1000);
    await until(() => state(sync) === "ready:clean", "clean");
    expect(api.putCalls).toBe(2);
    expect(await remoteText(api)).toBe("one two");
  });
});

describe("conflicts", () => {
  async function conflicted() {
    const ctx = setup();
    await seedRemote(ctx.api, "base", 1);
    await ctx.sync.start();
    await seedRemote(ctx.api, "theirs", 2); // another tab saved meanwhile
    ctx.sync.setText("mine");
    vi.advanceTimersByTime(1000);
    await until(() => state(ctx.sync) === "ready:conflict", "conflict");
    return ctx;
  }

  it("stops autosaving and keeps local text in pending", async () => {
    const { api, pending, sync } = await conflicted();
    expect(pending.load(ID)).not.toBeNull();
    sync.setText("mine, edited more");
    vi.advanceTimersByTime(10_000);
    expect(api.putCalls).toBe(1);
    expect(sync.getSnapshot().text).toBe("mine, edited more");
  });

  it("load theirs: replaces local text", async () => {
    const { api, pending, sync } = await conflicted();
    await sync.resolveConflict("theirs");
    expect(sync.getSnapshot().text).toBe("theirs");
    expect(state(sync)).toBe("ready:clean");
    expect(pending.load(ID)).toBeNull();
    expect(api.notes.get(ID)!.version).toBe(2);
  });

  it("keep mine: overwrites on top of the latest version", async () => {
    const { api, sync } = await conflicted();
    await sync.resolveConflict("mine");
    await until(() => state(sync) === "ready:clean", "clean");
    expect(await remoteText(api)).toBe("mine");
    expect(api.notes.get(ID)!.version).toBe(3);
  });
});

describe("offline", () => {
  it("stores ciphertext, retries with backoff, then clears pending", async () => {
    const { api, storage, pending, sync } = setup();
    await sync.start();
    api.failures.push(new NetworkError(), new NetworkError());
    sync.setText("offline words");
    vi.advanceTimersByTime(1000);
    await until(() => state(sync) === "ready:unsaved", "unsaved");
    expect(sync.getSnapshot().status).toEqual({ kind: "ready", save: { kind: "unsaved", retryInMs: 1000 } });
    expect(storage.getItem(`pending:${ID}`)).not.toContain("offline words");

    vi.advanceTimersByTime(1000);
    await until(() => api.putCalls === 2 && state(sync) === "ready:unsaved", "second failure");
    expect(sync.getSnapshot().status).toEqual({ kind: "ready", save: { kind: "unsaved", retryInMs: 2000 } });

    vi.advanceTimersByTime(2000);
    await until(() => state(sync) === "ready:clean", "clean");
    expect(await remoteText(api)).toBe("offline words");
    expect(pending.load(ID)).toBeNull();
  });

  it("retryNow skips the wait", async () => {
    const { api, sync } = setup();
    await sync.start();
    api.failures.push(new NetworkError());
    sync.setText("x");
    vi.advanceTimersByTime(1000);
    await until(() => state(sync) === "ready:unsaved", "unsaved");
    sync.retryNow();
    await until(() => state(sync) === "ready:clean", "clean");
    expect(api.putCalls).toBe(2);
  });

  it("resumes a pending save on the next load", async () => {
    const { api, pending, sync } = setup();
    pending.save(ID, { encrypted: await encryptNote(key, ID, "from last time"), baseVersion: 0 });
    await sync.start();
    expect(sync.getSnapshot().text).toBe("from last time");
    expect(state(sync)).toBe("ready:clean");
    expect(await remoteText(api)).toBe("from last time");
    expect(pending.load(ID)).toBeNull();
  });

  it("turns a stale pending save into a conflict instead of overwriting", async () => {
    const { api, pending, sync } = setup();
    await seedRemote(api, "server copy", 1);
    pending.save(ID, { encrypted: await encryptNote(key, ID, "stale local"), baseVersion: 0 });
    await sync.start();
    expect(state(sync)).toBe("ready:conflict");
    expect(sync.getSnapshot().text).toBe("stale local");
    expect(await remoteText(api)).toBe("server copy");
  });
});

describe("other failures", () => {
  it("too large: waits for the next edit, then saves", async () => {
    const { api, sync } = setup();
    await sync.start();
    api.failures.push(new TooLargeError());
    sync.setText("huge");
    vi.advanceTimersByTime(1000);
    await until(() => state(sync) === "ready:tooLarge", "tooLarge");
    sync.setText("small");
    vi.advanceTimersByTime(1000);
    await until(() => state(sync) === "ready:clean", "clean");
    expect(await remoteText(api)).toBe("small");
  });

  it("dispose flushes unsaved edits once and cancels the debounce", async () => {
    const { api, sync } = setup();
    await sync.start();
    sync.setText("bye");
    sync.dispose();
    await until(() => api.putCalls === 1, "flush on dispose");
    vi.advanceTimersByTime(5000);
    expect(api.putCalls).toBe(1);
  });

  it("restarting (StrictMode remount) ignores the stale first run", async () => {
    const { api, sync } = setup();
    await seedRemote(api, "hello");
    const first = sync.start();
    sync.dispose();
    await sync.start();
    await first;
    expect(sync.getSnapshot().text).toBe("hello");
    expect(state(sync)).toBe("ready:clean");
  });
});
```

Run: `cd client && npx vitest run src/notes/noteSync`
Expected: FAIL — cannot resolve `./noteSync`.

- [ ] **Step 2: Implement NoteSync**

`client/src/notes/noteSync.ts`:
```ts
import { DecryptError, decryptNote, encryptNote } from "../crypto/cipher";
import type { NoteKeys } from "../crypto/derive";
import { ConflictError, TooLargeError, isRetryable, type NotesApi } from "./api";
import type { PendingStore } from "./pending";

export type SaveState =
  | { kind: "clean"; savedAt: number | null } // savedAt null: nothing on the server yet
  | { kind: "dirty" } // edits waiting for the debounce
  | { kind: "saving" }
  | { kind: "unsaved"; retryInMs: number } // offline / server error; retry scheduled
  | { kind: "conflict" } // someone else saved first; user must choose
  | { kind: "tooLarge" };

export type NoteStatus =
  | { kind: "deriving" }
  | { kind: "loading" }
  | { kind: "ready"; save: SaveState }
  | { kind: "unreadable" }
  | { kind: "error"; message: string };

export interface NoteSnapshot {
  status: NoteStatus;
  text: string;
}

export interface NoteSyncDeps {
  api: NotesApi;
  pending: PendingStore;
  derive: (name: string) => Promise<NoteKeys>;
  debounceMs?: number;
}

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

/**
 * Owns one note's lifecycle: derive keys, load + decrypt, debounced encrypted
 * saves (one in flight at a time), conflicts, and offline retry. Framework-free;
 * React binds to it with useSyncExternalStore (see useNote.ts).
 */
export class NoteSync {
  private readonly name: string;
  private readonly deps: NoteSyncDeps;
  private readonly debounceMs: number;
  private readonly listeners = new Set<() => void>();

  private snapshot: NoteSnapshot = { status: { kind: "deriving" }, text: "" };
  private keys: NoteKeys | null = null;
  private version = 0; // server version our text is based on
  private dirty = false; // local text differs from what the last started save sent
  private inFlight = false;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelayMs = FIRST_RETRY_MS;
  private run = 0; // bumps on start/dispose; async work from an older run is ignored

  constructor(name: string, deps: NoteSyncDeps) {
    this.name = name;
    this.deps = deps;
    this.debounceMs = deps.debounceMs ?? 1000;
  }

  // Arrow properties so React can pass them around without losing `this`.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): NoteSnapshot => this.snapshot;

  async start(): Promise<void> {
    const run = ++this.run;
    this.set({ status: { kind: "deriving" } });
    try {
      const keys = await this.deps.derive(this.name);
      if (run !== this.run) return;
      this.keys = keys;
      this.set({ status: { kind: "loading" } });

      const remote = await this.deps.api.getNote(keys.id);
      if (run !== this.run) return;
      const text = remote ? await decryptNote(keys.key, keys.id, remote) : "";
      if (run !== this.run) return;

      this.version = remote?.version ?? 0;
      this.dirty = false;
      this.set({ text, status: { kind: "ready", save: { kind: "clean", savedAt: remote?.updatedAt ?? null } } });
      await this.resumePending(run);
    } catch (err) {
      if (run !== this.run) return;
      if (err instanceof DecryptError) {
        this.set({ status: { kind: "unreadable" } });
      } else {
        this.set({ status: { kind: "error", message: "could not load this note" } });
      }
    }
  }

  setText = (text: string): void => {
    const status = this.snapshot.status;
    if (status.kind !== "ready") return;
    this.dirty = true;
    const save = status.save;
    // Conflict waits for the user; unsaved has a retry timer; saving re-flushes when done.
    const keep = save.kind === "conflict" || save.kind === "unsaved" || save.kind === "saving";
    this.set({ text, status: { kind: "ready", save: keep ? save : { kind: "dirty" } } });
    if (save.kind === "conflict" || save.kind === "unsaved") return;
    this.scheduleSave();
  };

  resolveConflict = async (choice: "theirs" | "mine"): Promise<void> => {
    const keys = this.keys;
    if (!keys) return;
    const run = this.run;
    try {
      const remote = await this.deps.api.getNote(keys.id);
      if (run !== this.run) return;
      this.version = remote?.version ?? 0;
      if (choice === "theirs") {
        const text = remote ? await decryptNote(keys.key, keys.id, remote) : "";
        if (run !== this.run) return;
        this.dirty = false;
        this.deps.pending.clear(keys.id);
        this.set({ text, status: { kind: "ready", save: { kind: "clean", savedAt: remote?.updatedAt ?? null } } });
      } else {
        this.dirty = true;
        this.setSave({ kind: "dirty" });
        await this.flush();
      }
    } catch (err) {
      if (run !== this.run) return;
      if (err instanceof DecryptError) this.set({ status: { kind: "unreadable" } });
      else this.setSave({ kind: "conflict" }); // still unresolved; the user can try again
    }
  };

  /** Retry a failed save now (e.g. the browser fired "online"). */
  retryNow = (): void => {
    if (this.retryTimer === undefined) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    void this.flush();
  };

  dispose(): void {
    if (this.dirty) void this.flush(); // best effort: send what was typed in the last second
    this.run++;
    clearTimeout(this.debounceTimer);
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private async resumePending(run: number): Promise<void> {
    const keys = this.keys!;
    const pending = this.deps.pending.load(keys.id);
    if (!pending) return;
    let text: string;
    try {
      text = await decryptNote(keys.key, keys.id, pending.encrypted);
    } catch {
      this.deps.pending.clear(keys.id); // not ours / corrupt: drop it
      return;
    }
    if (run !== this.run) return;
    this.version = pending.baseVersion; // if the server moved on, the PUT will 409 → conflict
    this.dirty = true;
    this.set({ text, status: { kind: "ready", save: { kind: "dirty" } } });
    await this.flush();
  }

  private scheduleSave(): void {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  private async flush(): Promise<void> {
    const keys = this.keys;
    if (!keys || this.inFlight || !this.dirty) return;
    const run = this.run;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.inFlight = true;
    this.dirty = false;
    this.setSave({ kind: "saving" });

    try {
      const encrypted = await encryptNote(keys.key, keys.id, this.snapshot.text);
      try {
        const res = await this.deps.api.putNote(keys.id, encrypted, this.version);
        if (run !== this.run) return;
        this.version = res.version;
        this.retryDelayMs = FIRST_RETRY_MS;
        this.deps.pending.clear(keys.id);
        if (this.dirty) {
          this.setSave({ kind: "dirty" });
          this.scheduleSave();
        } else {
          this.setSave({ kind: "clean", savedAt: res.updatedAt });
        }
      } catch (err) {
        if (run !== this.run) return;
        this.dirty = true;
        if (err instanceof ConflictError) {
          this.deps.pending.save(keys.id, { encrypted, baseVersion: this.version });
          this.setSave({ kind: "conflict" });
        } else if (err instanceof TooLargeError) {
          this.setSave({ kind: "tooLarge" });
        } else if (isRetryable(err)) {
          this.deps.pending.save(keys.id, { encrypted, baseVersion: this.version });
          const delay = this.retryDelayMs;
          this.retryDelayMs = Math.min(delay * 2, MAX_RETRY_MS);
          this.setSave({ kind: "unsaved", retryInMs: delay });
          this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            void this.flush();
          }, delay);
        } else {
          this.set({ status: { kind: "error", message: "the server rejected this save" } });
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  private setSave(save: SaveState): void {
    if (this.snapshot.status.kind === "ready") this.set({ status: { kind: "ready", save } });
  }

  private set(patch: Partial<NoteSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }; // new object → React sees the change
    for (const listener of this.listeners) listener();
  }
}
```

- [ ] **Step 3: Run the tests**

Run: `cd client && npx vitest run src/notes/noteSync`
Expected: all PASS. If one fails, debug the state machine using superpowers:systematic-debugging — do not loosen the assertion.

- [ ] **Step 4: Run all client checks**

Run: `cd client && npx vitest run && npx tsc -b && npm run lint`
Expected: all PASS.

- [ ] **Step 5: Append to LEARNING.md**

```markdown

## Design: state machines outside the UI
- `NoteSync` is a plain class with explicit states; React only renders them. Easy to unit-test, easy to reason about.
- Debounce = reset a timer on every keystroke; save when it finally fires.
- Single-flight = never two saves at once; edits during a save set `dirty`, which triggers exactly one follow-up.

## Design: run counters vs stale async work
- Every `start()`/`dispose()` bumps `run`; each async step checks `if (run !== this.run) return`.
- Needed because React StrictMode (dev only) mounts → unmounts → mounts effects to expose bugs like this.

## Design: exponential backoff
- Retry after 1s, 2s, 4s… capped at 30s: gentle on a struggling server, quick when it's a blip.

## Testing: fake timers + real async
- `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })` → `vi.advanceTimersByTime(ms)` fires timers instantly.
- WebCrypto runs on Node's thread pool, outside fake time; wait for it by yielding with real `setImmediate` in a loop.
```

- [ ] **Step 6: Commit**

```bash
git add client/src/notes LEARNING.md
git commit -m "feat(client): NoteSync state machine with debounce, conflicts and offline retry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: React hook + pages

**Concept:** `useSyncExternalStore(subscribe, getSnapshot)` is React's official way to read state that lives *outside* React (our `NoteSync`): React re-renders whenever the snapshot reference changes. `useMemo` creates one `NoteSync` per name; `useEffect` starts it and cleans up (dispose + remove the `online` listener). Giving `<NoteEditor key={name}>` a key makes React throw away all state when you navigate to another note. Routing: `/` is Home; `/*` catches every other path — including names with `/` — and redirects non-canonical forms (`/Taco`) to the canonical encoded URL. Comparing *decoded* names prevents redirect loops.

**Files:**
- Create: `client/src/notes/useNote.ts`, `client/src/pages/Home.tsx`, `client/src/pages/NotePage.tsx`
- Modify: `client/src/App.tsx`, `LEARNING.md`

**Interfaces:**
- Consumes: `NoteSync`, `NoteSnapshot`, `SaveState`; `createNotesApi`; `createPendingStore`; `deriveNoteKeys`; `normalizeName`, `generateName`, `estimateStrength`.
- Produces: `useNote(name: string): NoteSnapshot & { setText: (text: string) => void; resolveConflict: (choice: "theirs" | "mine") => Promise<void> }`; routes `/` and `/*`.

- [ ] **Step 1: Write the hook**

`client/src/notes/useNote.ts`:
```ts
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { deriveNoteKeys } from "../crypto/derive";
import { createNotesApi } from "./api";
import { NoteSync } from "./noteSync";
import { createPendingStore } from "./pending";

const api = createNotesApi();

/** Binds one note (by normalized name) to React. */
export function useNote(name: string) {
  const sync = useMemo(
    () => new NoteSync(name, { api, pending: createPendingStore(localStorage), derive: deriveNoteKeys }),
    [name],
  );

  useEffect(() => {
    void sync.start();
    const onOnline = () => sync.retryNow();
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("online", onOnline);
      sync.dispose();
    };
  }, [sync]);

  const snapshot = useSyncExternalStore(sync.subscribe, sync.getSnapshot);
  return { ...snapshot, setText: sync.setText, resolveConflict: sync.resolveConflict };
}
```

- [ ] **Step 2: Write the Home page**

`client/src/pages/Home.tsx`:
```tsx
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { estimateStrength, generateName, normalizeName } from "../names/names";

export default function Home() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const normalized = normalizeName(name);
  const strength = normalized ? estimateStrength(normalized) : null;

  const open = (e: FormEvent) => {
    e.preventDefault();
    if (normalized) navigate(`/${encodeURIComponent(normalized)}`);
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold">flako</h1>
      <p className="text-sm">
        Pick a name. The name is the key: anyone who knows it can read and edit the note, and the server never
        learns it.
      </p>
      <form onSubmit={open} className="flex gap-2">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="note name"
          aria-label="note name"
          className="flex-1 border p-2 font-mono"
        />
        <button type="submit" className="border px-3" disabled={!normalized}>
          open
        </button>
      </form>
      <button type="button" onClick={() => setName(generateName())} className="self-start text-sm underline">
        generate one
      </button>
      {strength && (
        <p className="text-sm" data-level={strength.level}>
          {strength.message} (~{strength.bits} bits)
        </p>
      )}
    </main>
  );
}
```

- [ ] **Step 3: Write the Note page**

`client/src/pages/NotePage.tsx`:
```tsx
import type { ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { normalizeName } from "../names/names";
import type { SaveState } from "../notes/noteSync";
import { useNote } from "../notes/useNote";

function nameFromPath(pathname: string): string {
  const raw = pathname.slice(1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // malformed escape like "%E0%A4%A": treat literally
  }
}

export default function NotePage() {
  const { pathname } = useLocation();
  const decoded = nameFromPath(pathname);
  const name = normalizeName(decoded);

  if (!name) return <Navigate to="/" replace />;
  // Compare decoded forms so an encoded canonical URL never redirects again (no loops).
  if (name !== decoded) return <Navigate to={`/${encodeURIComponent(name)}`} replace />;
  return <NoteEditor key={name} name={name} />;
}

function NoteEditor({ name }: { name: string }) {
  const { status, text, setText, resolveConflict } = useNote(name);

  if (status.kind === "deriving") return <Centered>deriving keys for “{name}”…</Centered>;
  if (status.kind === "loading") return <Centered>fetching…</Centered>;
  if (status.kind === "unreadable")
    return <Centered>this note exists but cannot be decrypted with this name. saving is disabled.</Centered>;
  if (status.kind === "error") return <Centered>{status.message}. reload to try again.</Centered>;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-3 p-6">
      <header className="flex items-baseline justify-between gap-4 text-sm">
        <Link to="/" className="underline">
          home
        </Link>
        <span className="truncate font-mono">/{name}</span>
        <span aria-live="polite">{describeSave(status.save)}</span>
      </header>

      {status.save.kind === "conflict" && (
        <div role="alert" className="flex flex-wrap gap-3 border p-3 text-sm">
          <span>this note was changed somewhere else.</span>
          <button className="underline" onClick={() => void resolveConflict("theirs")}>
            load theirs
          </button>
          <button className="underline" onClick={() => void resolveConflict("mine")}>
            overwrite with mine
          </button>
        </div>
      )}

      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="type. it encrypts itself."
        className="min-h-[70vh] w-full resize-none border p-4 font-mono focus:outline-none"
      />
    </main>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <p className="p-10 text-center font-mono text-sm">{children}</p>;
}

function describeSave(save: SaveState): string {
  switch (save.kind) {
    case "clean":
      return save.savedAt ? `saved ${new Date(save.savedAt).toLocaleTimeString()}` : "nothing saved yet";
    case "dirty":
      return "unsaved changes";
    case "saving":
      return "saving…";
    case "unsaved":
      return `offline: retrying in ${Math.round(save.retryInMs / 1000)}s`;
    case "conflict":
      return "conflict";
    case "tooLarge":
      return "too large to save";
  }
}
```

- [ ] **Step 4: Wire routes**

`client/src/App.tsx`:
```tsx
import { Route, Routes } from "react-router-dom";
import Home from "./pages/Home";
import NotePage from "./pages/NotePage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/*" element={<NotePage />} />
    </Routes>
  );
}
```

- [ ] **Step 5: Static checks**

Run: `cd client && npx vitest run && npx tsc -b && npm run lint`
Expected: all PASS.

- [ ] **Step 6: Manual end-to-end check in dev**

Start both (background processes or two terminals): `cd server && go run ./cmd/server` and `cd client && npm run dev`. Open `http://localhost:5173`. Verify each, and report results in chat:
1. Home → "generate one" shows a 4-word name and "strong … (~52 bits)"; typing `taco` shows "weak".
2. Open `/Taco ` (with capital + trailing space, via the address bar as `/Taco%20`) → URL becomes `/taco`, shows "deriving…" briefly, then an empty editor with "nothing saved yet".
3. Type text → "unsaved changes" → ~1s later "saved HH:MM:SS". Reload → text comes back.
4. Delete all text → saves; reload → empty.
5. Open the same note in a second tab, edit in tab A and save, then edit in tab B → B shows the conflict banner; "load theirs" shows A's text; repeat and "overwrite with mine" wins.
6. Stop the Go server, type → "offline: retrying in 1s/2s/4s…"; DevTools → Application → Local Storage shows `pending:<id>` containing only base64. Restart the server → becomes "saved".
7. `grep -a -c "<a phrase you typed>" server/data/notes.db server/data/notes.db-wal 2>/dev/null` → all counts `0`; same for the word `taco`.

- [ ] **Step 7: Append to LEARNING.md**

```markdown

## React: external stores
- `useSyncExternalStore(subscribe, getSnapshot)` re-renders when `getSnapshot()` returns a new reference.
- Keep `getSnapshot` cheap and stable (return the same object until something changes).

## React: effects and StrictMode
- `useEffect` returns a cleanup; in dev StrictMode runs effect → cleanup → effect to catch missing cleanups.
- `key={name}` on a component resets all its state when the key changes.

## Routing: canonical URLs without loops
- Decode the path, normalize, compare with the *decoded* path; redirect only if they differ.
- Comparing encoded vs decoded strings would redirect forever on names with spaces.
```

- [ ] **Step 8: Commit**

```bash
git add client/src LEARNING.md
git commit -m "feat(client): note editor and home pages wired to NoteSync

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Single-binary production build

**Concept:** `//go:embed all:dist` puts the built React app *inside* the Go binary; `all:` includes dotfiles like `.gitkeep`, which keeps the pattern valid before the first client build (an embed pattern matching nothing is a compile error). A **SPA fallback** serves `index.html` for any unknown path so client-side routes like `/taco` work on refresh, while missing `/assets/*` files still 404 (serving HTML for a missing JS file causes confusing errors). One binary + one SQLite file is the whole deployment unit Phase 5 will ship.

**Files:**
- Create: `server/internal/web/web.go`, `server/internal/web/web_test.go`, `server/internal/web/dist/.gitkeep`, `README.md`
- Modify: `server/cmd/server/main.go`, `client/vite.config.ts`, `client/package.json`, `.gitignore`, `LEARNING.md`

**Interfaces:**
- Consumes: built client in `server/internal/web/dist/`.
- Produces: `func NewSPAHandler(fsys fs.FS) http.Handler`, `func Handler() http.Handler`; `GET /` route in main.

- [ ] **Step 1: Write failing SPA tests**

`server/internal/web/web_test.go`:
```go
package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestSPAHandler(t *testing.T) {
	fsys := fstest.MapFS{
		"index.html":    {Data: []byte("<html>app</html>")},
		"assets/app.js": {Data: []byte("console.log(1)")},
	}
	h := NewSPAHandler(fsys)

	cases := []struct {
		path       string
		wantStatus int
		wantBody   string
	}{
		{"/", 200, "<html>app</html>"},
		{"/assets/app.js", 200, "console.log(1)"},
		{"/taco", 200, "<html>app</html>"},
		{"/my%20notes/work", 200, "<html>app</html>"},
		{"/assets/missing.js", 404, ""},
	}
	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest("GET", tc.path, nil))
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", rec.Code, tc.wantStatus)
			}
			if tc.wantBody != "" && rec.Body.String() != tc.wantBody {
				t.Errorf("body = %q, want %q", rec.Body, tc.wantBody)
			}
		})
	}
}

func TestSPAHandlerWithoutBuild(t *testing.T) {
	h := NewSPAHandler(fstest.MapFS{".gitkeep": {}})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), "npm run build") {
		t.Fatalf("got %d %q, want 503 with build hint", rec.Code, rec.Body)
	}
}
```

Run: `cd server && go test ./internal/web/`
Expected: FAIL — `undefined: NewSPAHandler`.

- [ ] **Step 2: Implement the SPA handler**

```bash
mkdir -p server/internal/web/dist && touch server/internal/web/dist/.gitkeep
```

`server/internal/web/web.go`:
```go
// Package web serves the built React app embedded in the binary.
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// all: includes dotfiles, so .gitkeep keeps this valid before the first client build.
//
//go:embed all:dist
var embedded embed.FS

// Handler serves the client compiled into the binary.
func Handler() http.Handler {
	dist, err := fs.Sub(embedded, "dist")
	if err != nil {
		panic(err) // impossible: "dist" is embedded above
	}
	return NewSPAHandler(dist)
}

// NewSPAHandler serves files from fsys and falls back to index.html for
// client-side routes. Missing /assets/* files 404 instead of returning HTML.
func NewSPAHandler(fsys fs.FS) http.Handler {
	files := http.FileServerFS(fsys)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := fs.Stat(fsys, "index.html"); err != nil {
			http.Error(w, "client not built: run `npm run build` in client/ (or use the Vite dev server on :5173)",
				http.StatusServiceUnavailable)
			return
		}

		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name != "" {
			if info, err := fs.Stat(fsys, name); err == nil && !info.IsDir() {
				files.ServeHTTP(w, r)
				return
			}
			if strings.HasPrefix(name, "assets/") {
				http.NotFound(w, r)
				return
			}
		}
		serveIndex(w, fsys)
	})
}

func serveIndex(w http.ResponseWriter, fsys fs.FS) {
	data, err := fs.ReadFile(fsys, "index.html")
	if err != nil {
		http.Error(w, "index.html unreadable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache") // always pick up new builds
	_, _ = w.Write(data)
}
```

Run: `cd server && go test ./internal/web/ -v`
Expected: PASS.

- [ ] **Step 3: Mount it in main**

In `server/cmd/server/main.go`, add the import `"github.com/Mesfrum/flako/server/internal/web"` and, right after `httpapi.New(st, logger).Routes(mux)`, add:
```go
	mux.Handle("GET /", web.Handler()) // everything that isn't /api or /healthz
```

- [ ] **Step 4: Point the client build at the embed directory**

`client/vite.config.ts` — add a `build` block next to `server`:
```ts
  build: {
    outDir: "../server/internal/web/dist",
    emptyOutDir: true, // wipes .gitkeep too; postbuild restores it
  },
```

`client/package.json` `"scripts"` — add:
```json
    "postbuild": "node -e \"require('fs').writeFileSync('../server/internal/web/dist/.gitkeep', '')\"",
```

Root `.gitignore` — append:
```gitignore

# Built client embedded into the Go binary (keep the placeholder)
server/internal/web/dist/*
!server/internal/web/dist/.gitkeep
```

- [ ] **Step 5: Build and run the single binary**

```bash
cd client && npm run build
cd ../server && go vet ./... && go test ./... && go build -o tmp/flako.exe ./cmd/server
```
Expected: Vite writes to `server/internal/web/dist/`; `.gitkeep` is present afterwards (`ls -a server/internal/web/dist`); all Go tests pass; binary builds.

Run `./tmp/flako.exe` (background) and open `http://localhost:8080/some-note` directly (refresh-safe deep link). Verify: editor loads, typing saves, reload restores text, `curl -s localhost:8080/api/nope` returns JSON 404, `curl -s -o /dev/null -w '%{http_code}' localhost:8080/assets/nope.js` prints `404`. `git status` shows no files under `server/internal/web/dist/` except possibly `.gitkeep`.

- [ ] **Step 6: Write the README**

`README.md`:
````markdown
# flako

A shrib-style notepad: go to `/<any-name>` and start typing. The name is the key — notes are
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
cd server && go build -o flako ./cmd/server
./flako                            # UI + API on :8080
```

Env vars (optional): `ADDR` (default `:8080`), `DB_PATH` (default `./data/notes.db`).

## Security model, honestly

- Anyone who knows (or guesses) a note's name can read and edit it. Short names are weak.
- The salt is app-wide by necessity, so one dictionary attack covers every note. Argon2id makes each guess cost ~0.5s and 64 MB.
- The server sees: note-id hashes, ciphertext sizes, and timing. Never names or text.
````

- [ ] **Step 7: Append to LEARNING.md**

```markdown

## Go: embedding a frontend
- `//go:embed all:dist` — `all:` includes dotfiles; a pattern that matches nothing fails to compile, so a committed `.gitkeep` keeps it valid.
- `fs.Sub(embedded, "dist")` re-roots the FS; `http.FileServerFS(fsys)` serves it (Go 1.22+).

## Web: SPA fallback
- Client-side routes (`/taco`) don't exist as files; serve `index.html` for unknown paths so refresh works.
- But return 404 for missing `/assets/*` — serving HTML as JavaScript produces baffling errors.

## Deploy shape
- One Go binary (API + UI) + one SQLite file. That's what Phase 5 will ship.
```

- [ ] **Step 8: Commit**

```bash
git add -A server client/vite.config.ts client/package.json .gitignore README.md LEARNING.md
git status --short   # confirm nothing from server/internal/web/dist except .gitkeep is staged
git commit -m "feat: embed built client into a single Go binary

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Final verification against spec §9**

Run all of: `cd server && go test ./...`, `cd client && npm test && npx tsc -b && npm run lint`. Then confirm each success criterion in chat with evidence:
- runs with no Docker / external services (Task 10 Step 6, Task 11 Step 5);
- persists across reload and server restart (restart the binary, reload the page);
- SQLite contains no plaintext and no names (`grep -a -c` → 0);
- two tabs never silently lose data (Task 10 Step 6.5);
- all tests pass; `LEARNING.md` has entries for every concept in spec §8.
