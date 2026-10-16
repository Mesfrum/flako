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
