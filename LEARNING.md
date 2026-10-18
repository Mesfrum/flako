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

## Snapshots and run-length encoding
- A snapshot = the whole CRDT (tombstones too) as one blob, so joiners don't replay every op. Stored forever → versioned (`v: 1`).
- Consecutive ids from one replica that sit next to each other with the same visibility collapse into one run `[replica, firstCounter, "text"]`.
- Store the Lamport clock too, so a restored replica never reuses a counter.

## Performance budgets in tests
- "2,000 keystrokes in a 100 KB note < 300 ms" is a test like any other: if it fails, the code gets faster, the budget doesn't move.
- What made it fast here: chunks of ~512 elements with cached visible counts (skip whole chunks to find index N),
  a two-level Map (replica → counter) instead of string keys like "r:c", and never `array.splice(i, 0, ...hugeArray)` (blows the call stack).

## Undo in collaborative editors (selective undo via inverse ops)
- "Go back to the previous version" would erase collaborators' work. Collaborative undo = undo MY ops only.
- Record my own local ops in steps (keystrokes < 500 ms apart group together; moving the caret breaks the group).
- Undo applies inverses as new ops: insert → delete those exact ids, delete → undelete those ids. Redo re-applies.
- Inverses are ordinary CRDT ops with fresh Lamport stamps, so they sync and converge like any edit.

## Diffing input into operations
- A textarea only reports its new value. Common prefix + common suffix of old/new → one splice (index, remove, insert).
- Ambiguity ("aa" → "aaa") is settled by the caret: the common suffix may not reach left of the caret.
- JS strings are UTF-16: "🌮" is two code units (a surrogate pair), and 🌮/🌯 share the first one.
  Move splice edges outward so a pair is never split.

## Anchors vs indices
- "Position 6" breaks as soon as someone inserts before it. "Just after element id X" (null = start) survives anything.
- Back to an index: indexOf(X) + 1 if X is visible, + 0 if it was deleted meanwhile.

## Wire format: outside vs inside an encrypted message
- Outside (server-readable): message type, sequence numbers, ack ids, viewer count. Inside (sealed): edits, cursors, colours.
- Design the outside to be the minimum the server needs to route and order — everything else goes inside.

## AAD binding to stop cross-kind replay
- AES-GCM's additional data is authenticated but not encrypted. We use `"<noteId>|<kind>"`.
- A presence blob decrypted as "ops", or a blob from another note, fails authentication instead of being misread.

## Event sourcing: append-only logs
- Store every change as an immutable, numbered event (here: an encrypted op batch with seq 1, 2, 3 … per note).
- Current state = replay (or snapshot + replay of the tail). History comes for free — Phase 3's time machine.
- The server orders and stores events it cannot read; ordering needs no understanding of content.

## Atomic "next number" in SQL
- `INSERT … SELECT COALESCE(MAX(seq),0)+1 … RETURNING seq` is one statement; SQLite takes the write lock before
  evaluating the SELECT, so two appends can't both read the same MAX (verified: the 20-goroutine test passes even without a Go mutex).
- The `(note_id, seq)` primary key is the backstop that turns any bug into an error instead of a silent overwrite.
- A Go mutex in front is only a courtesy: our goroutines queue instead of retrying on SQLITE_BUSY.

## WebSockets vs HTTP
- HTTP: one request, one response. WebSocket: an HTTP request with `Upgrade: websocket` → `101 Switching Protocols`,
  and the same TCP connection becomes a long-lived two-way message pipe.
- In Go the handler "hijacks" the connection from net/http and keeps it until the conversation ends.

## Goroutine per connection + writer goroutine
- Reader: the handler's own goroutine loops on "read message, handle it". Writer: a second goroutine is the ONLY one that
  writes data frames. A third (pinger) sends WebSocket pings to detect dead peers.
- They share one `context`: whoever fails first calls `cancel()`, and everyone else's `select` sees `ctx.Done()`.

## Channels and select
- A channel is a typed pipe between goroutines. `select` waits on several at once and runs whichever is ready first.
- Two channels per peer: `direct` (replies; the sender may wait) and `bcast` (other people's messages; never waited on).

## Fan-out without blocking
- Broadcasting = `select { case p.bcast <- msg: default: }` for each peer. A full queue means "too slow" — never a frozen room.

## Long-lived connections vs server timeouts — a correction
- Plan assumption: http.Server's 15 s Read/WriteTimeout deadlines survive the upgrade and kill live notes.
- Reality (Go 1.24): net/http clears the deadlines when a handler hijacks the connection (server.go `hijackLocked`).
  A mutation test proved the "fix" was dead code, so it was removed; the test that a connection outlives the timeouts stays.
- Lesson: check the standard library too, not just the third-party library — and prove a fix matters by removing it.

## Unwrap and hijacking
- Middleware wraps http.ResponseWriter. The WebSocket library finds the real connection by calling `Unwrap()` repeatedly.
  Without `statusRecorder.Unwrap()` every upgrade through our logger fails (mutation-verified).

## Back-pressure: drop the slow consumer
- One peer that can't keep up must never stall the room. Each peer has a bounded broadcast queue; a full queue means
  "close this one connection" (4008), never "wait". It reconnects and catches up from its `have` — nothing lost.
- `sync.Once` makes "close this peer" happen once even if many broadcasts find it full at the same time.

## Ephemeral vs durable messages
- Durable: edit batches → appended to the op log, replayed forever.
- Ephemeral: cursor positions → relayed to whoever is in the room right now, never stored.
- The viewer count is the one fact the server knows anyway (it counts connections), so it is sent in plaintext.

## Local-first editing
- The keystroke updates the local CRDT and the screen immediately. Networking is a background pipeline:
  batch (50 ms) → seal → outbox (localStorage, ciphertext) → send → ack → remove from outbox.
- Offline is just "the pipeline is paused"; typing never notices.

## Contiguous sequence tracking (have)
- `have` = largest N such that every op 1..N was received (via catch-up, broadcast, or our own acks).
  Seqs that arrive out of order wait in a set until the gap fills. Reconnect says "hello, I have N".

## Outbox + ack = at-least-once; idempotence = exactly-once in effect
- Anything not acked is resent after a reconnect, so it may arrive twice — applying an op twice is a no-op.
- Another tab's leftover outbox entries are replayed locally too, so every tab shows what will be delivered.

## Heartbeats detect dead connections
- A socket can look open but be dead (laptop sleep, Wi-Fi switch). App-level ping every 25 s; no pong in 10 s → reconnect.

## Testing: wait for the thing you assert on
- A flaky test waited for "unsent > 0" (true instantly) and then read the outbox (filled after async encryption).
  Fix: wait for the outbox entry itself. Run new async tests 10–20× before trusting them.

## Presence and throttling
- A cursor is sent as anchors ("just after id X") so it stays on the right characters on the other screen as text shifts.
- Throttle: send at most once per 50 ms; later moves inside the window collapse into one trailing send.
- Re-send when someone new joins, so they see you without waiting for you to move.

## Consistent snapshots
- Only snapshot a state everyone already has: nothing queued, sealing or unacked of mine, and no gaps in what I received.
- Otherwise a joiner could start from text that existing peers never got (and maybe never will, if I crash).
- Lesson from the tests: the first version of this test passed for the wrong reason (a gap stopped `have`), so a
  mutation didn't fail it. Rewritten so the rule itself is what's exercised: my edit waits in the batch while others' ops arrive.

## IME composition
- Phone keyboards and CJK input build a word in a "composing" state; changing the text underneath breaks it.
- While composing, remote ops are held (still counted as received) and applied the moment composition ends.

## Deterministic ids for idempotent migrations
- Importing a Phase 1 note uses a reserved replica id and counter = index + 1, so two people importing at once
  produce byte-identical ops and the CRDT keeps one copy (mutation-verified: random ids → "legacy textlegacy text").
- The same ids pin "old character 6" forever, so unsent Phase 1 text can be merged precisely after later edits.
- Big pastes/imports are split into pieces of ≤ 16 Ki units and batches of ≤ 192 KiB JSON, under the 256 KiB frame limit.

## Testing two users at once: browser contexts
- A Playwright *browser context* is a fresh profile (own cookies, localStorage, IndexedDB), so two contexts on
  the same URL behave like two people: separate outboxes, separate replica ids, real WebSockets to a real server.
- Concurrency is just `Promise.all([A.keyboard.type(...), B.keyboard.type(...)])`; then wait until both
  textareas are equal (convergence) and assert on the exact merged text.
- Measure "feels instant" with the Event Timing API (`PerformanceObserver({ type: "event" })`) and "froze" with
  the longest gap between `requestAnimationFrame` callbacks.
- Lesson: always run a control. A 200 KB `keyboard.insertText` froze the tab for 87 s — but it is just as slow
  on a bare `<textarea>` with no app (quadratic in Chrome's insertText path). A real Ctrl+V took 0.6–1.6 s.

## Stale counts and two-queue ordering
- A value read under a lock is stale the moment the lock is released: the "here" count captured at join time was
  already wrong by the time the newcomer's catch-up finished, yet it was broadcast as if current.
- Each peer's writer does `select` over two channels (direct replies and broadcasts). `select` picks randomly among
  ready channels, so there is no ordering between the queues: a fresh broadcast can be written *before* an older
  welcome, and the welcome then wins because the client keeps the last message.
- Fix: after catch-up, re-read the room size under the lock and announce it to everyone, newcomer included. The
  welcome was already handed to the writer, so this fresh count is the last word each peer hears.
- Test: loop many rooms with peers joining together and assert the last count each peer saw equals the true size.
  Keep every connection open until all peers finish reading, or an early close legitimately changes the counts.

## Detecting a rewound log with an op fingerprint
- If the server's database is restored from an older backup, its log can be shorter (or different) than what a
  reconnecting tab already saw. A bare sequence number can't tell: `have = 5` against a log that now holds 7
  *different* ops looks normal, and the tab would silently merge two histories.
- Every op carries a random 12-byte IV, so the IV of the op at seq `have` is a cheap fingerprint of "this exact
  history up to here". The tab sends it as `haveIv`; the server looks up its own op at `have` and compares.
- Missing op, wrong seq or different IV means the histories diverged: the server replies `reset: true` and catches
  the tab up from zero (snapshot path), as for a fresh tab. A hello without `haveIv` keeps the old behaviour.
- The welcome also carries `seqIv` (IV of the server's latest op) so the client can remember a fingerprint to send next time.
- Mutation check: comparing only seq (ignoring IV) makes the "different IV" tests fail, proving the IV is what matters.

## Turning CRDT state back into ops
- A snapshot (RgaState) and an op log describe the same document, so a snapshot can be replayed as ops: one ins per run in document order, then a del/undel carrying each run's stamp. A replica that already holds some of the history just applies them; idempotence and last-writer-wins stamps make the rest a no-op.
- Anchoring each run on the previous element in document order, tombstones included, works: RGA's skip-bigger-ids rule only compares against elements after the anchor, so a replica missing some elements still places the run identically. Anchoring on the previous visible char breaks it (mutation-checked).
- The real trap was elsewhere: a snapshot merges consecutive ids into one run, but a replica may have received them as several small ops. An ins whose first id was known used to be dropped whole, losing the unseen tail. Fix: integrateInsert now integrates only the missing stretches of a run.
- Property test: replay a random prefix of a 3-replica op log, then the rebuilt ops, and demand equal text and equal toState() across 240 seeds. The partial-run bug showed at seed 116 and was invisible to small tests.

## Repairing after a server lost history
- Detecting a rewound server is half the job; the other half is giving back what it lost. The tab remembers the IV of the op at its `have` (from `op` messages, from the IV it sealed for its own acked batches, or from `welcome.seqIv`), sends it as `haveIv`, and on `welcome.reset` starts its bookkeeping over.
- The tempting fix is wrong: loading the server's snapshot into the visible CRDT would re-base the tab onto a state that may be *older* than what the user is looking at. Instead the tab keeps a second, hidden `Rga` for "what the server holds" (welcome snapshot plus every op until `synced`) and merges the server's content into the visible text through ops, so nothing visible is lost or duplicated.
- At `synced`, `opsFromState(visible state)` minus what the server replica already has is queued and sent in the normal batches. "Has it" for an insert means every char id is held (a partly-held run is sent whole; the CRDT integrates only the unknown stretch). For a delete it means the server's stamp on every char equals the op's stamp. A second tab that resets after the first repaired the note therefore sends nothing.
- Cheap lookup: the server replica is indexed as sorted runs per replica id and queried by binary search, instead of a map entry per character.
- Tests: FakeHub mirrors the Go rule and gains `rewind(n)`. Mutation checks: dropping `haveIv` fails every repair test; making the filter send everything fails the "already repaired" test; skipping the re-send fails the lost-edit tests. Re-basing via `loadSnapshot` on reset is a harmful mutation: it rebuilds as snapshot plus `history`, so text that arrived through an earlier welcome snapshot (never in `history`) vanishes (test P2/P3).
- The repair must survive a dropped connection: after a reset the tab has `have = 0`, so its next hello is a plain `have:0` and the server can't say "reset" again. A `repairPending` flag makes every welcome behave like a reset until `finishRepair` ran. General guard: once a snapshot has replaced the CRDT, later snapshots are merged as ops, never swapped in.

## Litestream: streaming the WAL
- SQLite in WAL mode appends every committed change to a `-wal` file and only later folds it into the main file
  (a "checkpoint"). Litestream is a second process that watches that WAL, cuts the new pages into small LTX files
  and uploads them to S3/R2 every `sync-interval` (we use 10 s, so a crash loses at most ~10 s of writes).
- Backup = a full snapshot (daily) + the chain of small changes after it. `litestream restore` downloads the newest
  snapshot and replays the changes. Retention (72 h) just deletes snapshots and changes older than that.
- Litestream does not sit inside the server: it opens the same DB file as a normal reader and takes over
  checkpointing so no WAL page is folded away before it has been uploaded. That is why the server and Litestream can
  be separate processes at all.
- On SIGTERM Litestream does one last sync before exiting, so we stop the server first (no more writes) and then
  Litestream: the final upload then contains everything the server committed.
- v0.5 allows only one `replica:` per DB (v0.3 had a `replicas:` list), expands `${VAR}` itself, and an unset var
  becomes an empty string. The R2 endpoint is just an S3 endpoint plus `region: auto`.
- Testing S3 code locally: point the same image at any S3-compatible server. MinIO would be the classic choice, but
  it no longer publishes images, so the harness uses SeaweedFS's S3 gateway; the endpoint override is a test-only env.

## Fail-open startup
- Rule: an optional feature must never be able to stop the required one. Backups are optional, the server is not.
- So the entrypoint does not use `set -e`, never exits because of a restore, and puts hard time limits on every
  external call (`timeout -s KILL 15` around the restore, 5 s around `integrity_check`) because a network call with no
  timeout is how a "backup problem" turns into an outage.
- Restore goes to a temp file next to the DB and is moved in (`mv` in one directory is atomic) only if
  `PRAGMA integrity_check` returns `ok`; anything else (error, timeout, junk, empty bucket) logs a warning and boots
  with an empty DB. Stale `-wal`/`-shm` files are deleted first because they belong to the old database file.
- Process layout: the server is the main process and Litestream runs beside it, not as its parent
  (`litestream replicate -exec` would take the server down whenever Litestream died). The script traps TERM, forwards
  it to the server, waits, then stops Litestream with a 15 s watchdog, and exits with the server's exit code.
- `wait` returns early when a trapped signal arrives, so it is called in a loop until the child is really gone.
  After a child dies, `kill -0 pid` can still succeed on the unreaped zombie; `wait pid` is the reliable check.
- Test every failure on purpose (wrong keys, black-holed endpoint, paused S3, junk objects, `kill -9` on Litestream)
  and assert the one thing that matters: `/healthz` answers. Then mutate the code (make a restore failure `exit 1`)
  and confirm those scenarios fail - otherwise the tests might pass for the wrong reason.

## Two Litestream writers during a deploy overlap — a correction
- Correction: an earlier version of this entry said a shared replica path was fine ("small data loss for a few
  seconds of overlap", "3 runs"). That was based on scenario 9 (4 runs, SeaweedFS standing in for R2, not R2), which
  restored C right after A stopped, on a tiny DB, while B was still running: it could not see the real hazard.
- What the Litestream v0.5.17 source says: `Replica.syncOnce` works out the replica's position once (`calcPos` = the
  highest L0 transaction id already in the bucket) and then uploads L0 files named by transaction id, with no check
  that the bucket's files came from *this* database and no second-writer detection. The files carry
  `HeaderFlagNoChecksum`, so restore cannot notice a broken chain either, and compaction lists source files in the
  bucket but prefers a same-named local file. Two writers therefore upload same-named files with different contents,
  and which one a restore applies is a matter of timing. A new scenario 9b (B keeps writing ~370 1 KB ops after the
  overlap, then C restores) happened to pass 4/4 on the shared path, but that is luck, not a guarantee.
- Fix: one replica path per boot, `flako/<boot id>/notes.db` (boot id = UTC timestamp + random suffix, so names sort
  by boot time); a boot restores from the newest path and never writes into another's. The losing writer is now
  always the OLD instance, and it loses its whole overlap window (everything it wrote after B restored), not "a few
  seconds"; open tabs re-send that. Finding "the newest path" needs a bucket listing: a tiny stdlib-only S3
  ListObjectsV2 client with a hand-written AWS SigV4 signer (checked against AWS's documented example signature).
- Side effect to remember: with per-boot paths, old paths pile up, so the bucket needs a lifecycle rule (delete after
  7 days). And Litestream only writes a new snapshot when the DB changed, so an idle instance's newest snapshot would
  age past that rule; a 12 h keepalive write keeps it fresh.

## Supervising a sidecar from a shell script
- Litestream runs beside the server, so if it dies nothing notices. A background shell function loops: start
  `litestream replicate &`, `wait` for it, log, sleep with exponential backoff (5 s doubling to a 60 s cap, reset
  after a healthy 5 min run), start again. It never touches the server, so a crashing sidecar can't take the app down.
- `wait` returns early when a trapped signal arrives, so "wait until it really exited" is a loop of `wait` + `kill -0`.
  On TERM the trap only sets a flag and forwards TERM to the child; the loop then sees the flag and stops restarting.
- A marker file (`/data/.restore-failed`) carries a decision across restarts on a persistent disk: "this local DB is
  not the backup, don't replicate it". State that must survive a restart goes on disk, not in a variable.

## Messages that arrive before the welcome
- The hub starts a peer's writer before it sends the welcome, so a broadcast op from someone else can reach a tab
  before its own welcome. On a normal reconnect that's harmless (it fills a gap above `have`). On a reset it was
  checked against the OLD `have` and then forgotten, leaving a permanent gap: `have` never advanced again that
  session. Fix: remember what this socket delivered before its welcome and keep the seqs newer than welcome.seq.
- General lesson: when a protocol has a "start over" message, anything that raced ahead of it belongs to the new era.
