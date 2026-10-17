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

## Web: fetch semantics
- `fetch` rejects ONLY when no response arrives (offline, DNS, CORS). A 500 resolves with `res.ok === false`.
- Turn statuses into typed errors once (`ConflictError`, `TooLargeError`...) and use `instanceof` everywhere else.

## Security: what goes in localStorage
- Any script on the page can read localStorage. We store pending saves as ciphertext only, so a leak reveals nothing.

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

## React: external stores
- `useSyncExternalStore(subscribe, getSnapshot)` re-renders when `getSnapshot()` returns a new reference.
- Keep `getSnapshot` cheap and stable (return the same object until something changes).

## React: effects and StrictMode
- `useEffect` returns a cleanup; in dev StrictMode runs effect → cleanup → effect to catch missing cleanups.
- `key={name}` on a component resets all its state when the key changes.

## Routing: canonical URLs without loops
- Decode the path, normalize, compare with the *decoded* path; redirect only if they differ.
- Comparing encoded vs decoded strings would redirect forever on names with spaces.

## Go: embedding a frontend
- `//go:embed all:dist` — `all:` includes dotfiles; a pattern that matches nothing fails to compile, so a committed `.gitkeep` keeps it valid.
- `fs.Sub(embedded, "dist")` re-roots the FS; `http.FileServerFS(fsys)` serves it (Go 1.22+).

## Web: SPA fallback
- Client-side routes (`/taco`) don't exist as files; serve `index.html` for unknown paths so refresh works.
- But return 404 for missing `/assets/*` — serving HTML as JavaScript produces baffling errors.

## Deploy shape
- One Go binary (API + UI) + one SQLite file. That's what Phase 5 will ship.

## Go gotcha: ServeMux pattern conflicts panic at startup
- Two patterns that overlap where neither is more specific make `mux.Handle` panic: `"GET /"` (narrower method,
  broader path) vs `"/api/"` (broader method, narrower path).
- Fix: register the catch-all as `"/"` (so `"/api/"` is strictly more specific) and check the method inside the handler.
- A test that builds the *real* mux (`newMux`) catches this; handler tests on their own mux never will.

## Go gotchas: nil interfaces and defer in loops
- An interface holding a typed nil is NOT nil: `var ce *ConflictError; var err error = ce; err != nil` is **true**.
  Return a literal `nil` for "no error", never a nil pointer of a concrete error type.
- `defer` runs when the *function* returns, not the loop iteration. `for _, f := range files { x.Open(); defer x.Close() }`
  keeps every file open until the end. Move the body into a helper function (like `applyMigration`) so each defer fires per item.

## Web: the URL fragment never reaches the server
- In `https://site/#/taco`, everything after `#` stays in the browser: it is not in the HTTP request,
  server logs, proxy logs, or the `Referer` header. A path (`/taco`) is sent on every page load.
- When the name is the key, it belongs in the fragment. `HashRouter` routes on `location.hash`.
- Defence in depth: the request logger still records page paths as `[page]`, in case an old-style link is used.

## Web: Web Workers
- The page has ONE thread for JS, layout and input: 0.5s of Argon2 there freezes typing and scrolling.
- `new Worker(new URL("./x.worker.ts", import.meta.url), { type: "module" })` starts a second thread (no DOM).
  Talk with `postMessage` / `onmessage`; pass `[buffer]` as a transfer list to move bytes instead of copying.
- We run only the slow Argon2 step there; HKDF + the non-extractable CryptoKey are made on the main thread where they're used.
- Keep a fallback (`typeof Worker === "undefined"` in Node tests, or a crashed worker) that does the same work inline.

## CRDTs: convergence, commutativity, idempotence
- A CRDT lets replicas edit independently; once everyone has the same set of ops, everyone has the same state.
- Needs: ops commute (any order → same result) and are idempotent (applying twice = once). Then networks can reorder, duplicate and delay freely.

## RGA: ids, insert-after, tie-break, tombstones
- Each character has a permanent id `(counter, replica)`. Insert = "after id X", never "at index 3" (indices shift under concurrency).
- Several inserts after the same X: skip right over elements with a BIGGER id, insert there → bigger id first, same on every replica.
- Delete hides the element (tombstone); it stays so concurrent inserts anchored to it still land correctly.
- Ops referencing ids we don't have yet are buffered and retried after every successful apply.

## Lamport clocks
- Counter = 1 + the largest counter ever seen (local or remote). Gives "newer ⇒ bigger" without synchronised wall clocks.
- Children always get bigger ids than their parent, which is why RGA's "skip bigger ids" rule is correct.

## Last-writer-wins registers (delete/undelete)
- Each delete/undelete carries its own Lamport stamp; an element keeps the biggest stamp it has seen and its kind decides visibility.
- Concurrent delete vs undelete therefore resolves the same everywhere.

## Testing: seeded property tests
- Instead of hand-picked cases: generate hundreds of random concurrent edits with a seeded PRNG, deliver them shuffled with duplicates, assert all replicas agree.
- Mutation check: break the algorithm on purpose and confirm the test goes red — otherwise the test proves nothing.
