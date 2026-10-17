# Phase 2 — Live Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two or more people with the same note open see each other's typing, cursors and a
viewer count live, with own-edits undo and offline merge. Everything stays end-to-end encrypted,
and typing feels as smooth as typing alone.

**Architecture:**
- Each client holds an RGA CRDT of the note and applies local edits instantly. It then batches
  them every ~50 ms, encrypts them (AES-GCM, kind-bound AAD) and sends them over a WebSocket.
- The Go server is a relay with a log: it assigns per-note sequence numbers, stores encrypted ops
  and client-made encrypted snapshots in SQLite, fans messages out per note room, and relays
  presence without storing it.
- A framework-free `LiveNote` engine owns sync, presence, undo, the outbox and reconnects. React
  only renders it.

**Tech Stack:**
- Server: Go 1.24, `github.com/coder/websocket` v1.8.15, `modernc.org/sqlite` v1.38.2.
- Client: React 18, Vite 6, TypeScript 5.7, Vitest 3, `hash-wasm`, a Web Worker.

**Spec:** `docs/superpowers/specs/2026-10-17-phase2-live-collaboration-design.md`. Read it with
this plan; it is the authority. Phase 1 context: `docs/superpowers/specs/2026-10-16-phase1-foundation-design.md`.

## Global Constraints

- **Branching:**
  - Work only on branch `phase2-live`.
  - Never merge to `master` or push it. One cutover at the end, done by the owner.
  - The deployed Phase 1 code is archived on `archive/phase1`.
- **Go:**
  - Module `github.com/Mesfrum/flako/server`, `go 1.24`.
  - Pin `github.com/coder/websocket@v1.8.15` (its go directive is 1.23; never take a version
    requiring Go > 1.24).
  - No other new Go dependencies. No new npm dependencies.
- **KDF is frozen:** Argon2id(salt `flako/v1`, 65536 KiB, t=3, p=1, 32 B) → HKDF-SHA256 with info
  `flako/v1/id` / `flako/v1/enc`. The KAT test (`taco` → `DqMCETSlWMyiBEuz-TOWLYfWY4EYFz8GGBMm0p3Xl1M`)
  must keep passing unchanged.
- **AES-256-GCM:** fresh random 12-byte IV per encryption; AAD = UTF-8 `"<noteId>|<kind>"`, where
  kind ∈ `ops` | `presence` | `snapshot`.
- **localStorage holds ciphertext only:** keys `outbox:<id>` (new) and `pending:<id>` (Phase 1,
  read once for migration).
- **Server never stores presence.** It never sees names, text, cursor positions or colours.
- **Server limits:**
  - 20 connections per note;
  - op batch ciphertext ≤ 256 KiB (`256 << 10`) decoded;
  - snapshot ciphertext ≤ 8 MiB (`8 << 20`) decoded;
  - server WebSocket ping every 30 s.
- **Client values:**
  - batch interval 50 ms; presence throttle 50 ms;
  - snapshot when ≥ 500 ops since the last snapshot;
  - visible text limit 1 MiB (`1 << 20`) of UTF-8;
  - undo grouping window 500 ms;
  - reconnect backoff 1 s doubling to 30 s;
  - app heartbeat: ping every 25 s, reconnect if no pong within 10 s.
- **Reserved import replica id:** `"0000000000000000"`. Per-visit replica ids are 16 lowercase hex
  chars (64 random bits).
- **UI stays minimal** (the owner likes it). No new UI libraries.
- **Commit trailer:** every commit message ends with
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_014gj9UXSr8baUUN4mSk51kd
  ```
- **Teaching:** each task opens with a **Concept** note. When executing, explain it to the owner in
  chat before coding, and append the listed entries to `LEARNING.md`.

## Review Focus

- **Mobile keyboards replacing a whole word** (autocorrect, IME composition): no doubled or
  missing characters, and remote edits don't break composition → `spliceFromChange` replacement
  tests in Task 5; `setComposing` test in Task 11.
- **Emoji and other surrogate pairs:** typing, deleting and remote-inserting next to "🌮" never
  splits a pair → Task 2 and Task 5 tests.
- **A laptop waking from sleep on a dead socket:** the client notices within ~35 s and reconnects
  instead of looking "live" forever → heartbeat test in Task 10.
- **Two tabs of the same note in one browser share `outbox:<id>`:** offline text from one tab is
  delivered exactly once in effect, with no duplicated text → shared-outbox test in Task 10.
- **The server restarting mid-session** (a deploy): clients reconnect with `have`, catch up, and
  lose nothing → reconnect-and-catch-up test in Task 10, plus a manual step in Task 14.

---

## File Map

**Server (`server/`)**

| File | Responsibility |
|---|---|
| `internal/noteid/noteid.go` | `Valid(id)`: the 43-char base64url id rule, shared by `httpapi` and `live` |
| `internal/store/oplog.go` | `StoredOp`, `Snapshot`, `OpLog` interface |
| `internal/store/memory.go`, `sqlite.go` | add the `OpLog` methods |
| `internal/store/migrations/002_ops.sql` | `ops` and `snapshots` tables |
| `internal/store/oplog_contract_test.go` | shared `OpLog` behaviour suite |
| `internal/live/messages.go` | wire structs (JSON) |
| `internal/live/hub.go` | `Hub`, rooms, peers, fan-out, catch-up |
| `internal/live/hub_test.go` | real-WebSocket integration tests |
| `internal/httpapi/api.go` | PUT → 410; uses `noteid` |
| `cmd/server/main.go` | mount `GET /api/notes/{id}/live` |

**Client (`client/src/`)**

| File | Responsibility |
|---|---|
| `crypto/derive.ts` | split into `argon2Master` + `keysFromMaster`; `deriveNoteKeys` unchanged |
| `crypto/derive.worker.ts`, `crypto/deriveInWorker.ts` | Argon2 off the main thread |
| `live/crdt/rga.ts` | RGA CRDT: ops, apply, indices, state |
| `live/crdt/undo.ts` | own-edits undo/redo |
| `live/editing.ts` | textarea change → splice; selection anchors |
| `live/protocol.ts` | client/server message types, payload types |
| `live/sealed.ts` | kind-bound encrypt/decrypt of payloads |
| `live/outbox.ts` | ciphertext-only unacked batches |
| `live/liveNote.ts` | the engine (state machine) |
| `live/testing/fakeHub.ts` | in-memory server for engine tests (test-only) |
| `live/wsTransport.ts` | browser WebSocket `Connect` |
| `live/useLiveNote.ts` | React binding |
| `components/LiveTextarea.tsx`, `components/RemoteCursors.tsx` | editor and cursor overlay |
| `pages/NotePage.tsx` | uses `useLiveNote` |

**Removed in Task 13:** `notes/noteSync.ts`, `notes/noteSync.test.ts`, `notes/useNote.ts`, and
`putNote` with its error types and tests in `notes/api.ts`.

---

### Task 1: Argon2 in a Web Worker

**Concept:**
- JavaScript runs your UI on one thread, so 0.5 s of Argon2 freezes typing and scrolling.
- A **Web Worker** is a second thread with no DOM. You send it messages, and it sends results back.
- We split derivation in two:
  - the slow, memory-hard Argon2 step runs in the worker;
  - the fast HKDF step stays on the main thread, so the non-extractable `CryptoKey` is created
    where it's used.
- The known-answer test proves the split changed nothing.

**Files:**
- Modify: `client/src/crypto/derive.ts`
- Create: `client/src/crypto/derive.worker.ts`, `client/src/crypto/deriveInWorker.ts`,
  `client/src/crypto/deriveInWorker.test.ts`
- Modify: `LEARNING.md`

**Interfaces:**
- Produces:
  ```ts
  // derive.ts
  export function argon2Master(normalizedName: string): Promise<Uint8Array>   // 32 bytes
  export function keysFromMaster(master: Uint8Array): Promise<NoteKeys>
  export function deriveNoteKeys(normalizedName: string): Promise<NoteKeys>   // = keysFromMaster(await argon2Master(n))
  // deriveInWorker.ts
  export function deriveNoteKeysInWorker(normalizedName: string): Promise<NoteKeys>
  ```

- [ ] **Step 1: Write the failing test** in `deriveInWorker.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { argon2Master, deriveNoteKeys, keysFromMaster } from "./derive";
import { deriveNoteKeysInWorker } from "./deriveInWorker";

describe("split derivation", () => {
  it("argon2Master + keysFromMaster equals deriveNoteKeys", async () => {
    const viaSplit = await keysFromMaster(await argon2Master("taco"));
    expect(viaSplit.id).toBe((await deriveNoteKeys("taco")).id);
    expect(viaSplit.id).toBe("DqMCETSlWMyiBEuz-TOWLYfWY4EYFz8GGBMm0p3Xl1M");
  });

  it("falls back to the main thread where Worker does not exist (Node), same answer", async () => {
    expect(typeof Worker).toBe("undefined");
    expect((await deriveNoteKeysInWorker("taco")).id).toBe("DqMCETSlWMyiBEuz-TOWLYfWY4EYFz8GGBMm0p3Xl1M");
  });
});
```

- [ ] **Step 2: Run it.** `cd client && npx vitest run src/crypto/deriveInWorker`. Expected: FAIL,
  because `argon2Master` is not exported.

- [ ] **Step 3: Implement.**
  - Refactor `derive.ts` into the two exported halves. `deriveNoteKeys` keeps its signature and is
    composed from them.
  - **`derive.worker.ts`:** receives `{ id: number, name: string }`, replies
    `{ id, master: Uint8Array }` or `{ id, error: string }`. Transfer the buffer.
  - **`deriveInWorker.ts`:**
    - If `typeof Worker === "undefined"`, return `deriveNoteKeys(name)`.
    - Otherwise use one lazily created
      `new Worker(new URL("./derive.worker.ts", import.meta.url), { type: "module" })`, match
      replies by `id`, then call `keysFromMaster`.
    - If the worker errors, fall back to the main thread for that call.

- [ ] **Step 4: Run all client checks.** `cd client && npx vitest run && npx tsc -b && npm run lint`.
  Expected: all pass, including the existing `derive.test.ts` KATs.

- [ ] **Step 5: Verify the worker bundles.** `cd client && npm run build`. Expected: the output
  lists a separate `derive.worker-*.js` asset.

- [ ] **Step 6: LEARNING.md.** Add "Web: Web Workers" (one UI thread; workers for CPU-heavy work;
  messages and transferables; why keys are made on the main thread).

- [ ] **Step 7: Commit:** `perf(client): derive Argon2 master key in a Web Worker`

---

### Task 2: RGA CRDT core

**Concept:**
- A **CRDT** is a data structure that several people can edit independently. Once everyone has
  seen the same set of operations, everyone has the same result, in any order.
- **RGA** gives each character a unique id `(counter, replica)` and says "insert after character
  X".
- **Lamport clocks:** counters are always one more than the largest counter seen, so later
  inserts have bigger ids.
- **Tie-break:** when two inserts land after the same character, the bigger id goes first.
- **Deletes don't remove:** they mark tombstones, so later inserts can still find their anchor.
- **Undelete** lets undo bring text back. Delete vs undelete is settled by **last-writer-wins** on
  a Lamport stamp.
- **Idempotence** (applying twice = once) makes resends harmless.

**Files:**
- Create: `client/src/live/crdt/rga.ts`, `client/src/live/crdt/rga.test.ts`
- Modify: `LEARNING.md`

**Interfaces:**
- Produces:
  ```ts
  export interface ElemId { c: number; r: string }               // Lamport counter, replica (16 hex)
  export interface IdRange { r: string; c: number; n: number }   // ids (r, c), (r, c+1) … (r, c+n-1)
  export type Op =
    | { k: "ins"; id: ElemId; after: ElemId | null; text: string } // chars get ids (id.c + i, id.r)
    | { k: "del"; at: ElemId; ranges: IdRange[] }                  // at = Lamport stamp of this op
    | { k: "undel"; at: ElemId; ranges: IdRange[] };
  export const IMPORT_REPLICA = "0000000000000000";
  export function compareIds(a: ElemId, b: ElemId): number       // by c, then r (string compare); <0, 0, >0
  export class Rga {
    constructor(replica: string);
    readonly replica: string;
    text(): string;
    get length(): number;                       // visible UTF-16 length
    insert(index: number, text: string): Op;    // local: applies and returns the op
    delete(index: number, count: number): Op | null;  // local; ranges = ids actually hidden; null if nothing
    deleteIds(ranges: IdRange[]): Op;           // local, by id (used by undo/redo)
    undeleteIds(ranges: IdRange[]): Op;
    apply(op: Op): boolean;                     // remote; idempotent; true if visible text changed
    idAt(index: number): ElemId;                // visible element at index, 0 ≤ index < length
    indexOf(id: ElemId): number;                // visible elements before id (works for tombstones)
    isVisible(id: ElemId): boolean;
    pendingCount(): number;                     // ops buffered for unknown references
  }
  ```

- [ ] **Step 1: Write the failing tests** in `rga.test.ts`. Use a seeded PRNG helper in the test
  file (mulberry32) so failures reproduce.

```ts
describe("Rga basics", () => {
  it("inserts, deletes and reports text", () => {
    const a = new Rga("aaaaaaaaaaaaaaaa");
    a.insert(0, "helo");
    a.insert(3, "l");
    expect(a.text()).toBe("hello");
    a.delete(0, 1);
    expect(a.text()).toBe("ello");
    expect(a.length).toBe(4);
  });
  it("delete of nothing returns null", () => {
    expect(new Rga("a".repeat(16)).delete(0, 0)).toBeNull();
  });
  it("two replicas converge on concurrent inserts at the same spot (bigger id first)", () => {
    const a = new Rga("aaaaaaaaaaaaaaaa"), b = new Rga("bbbbbbbbbbbbbbbb");
    const base = a.insert(0, "xy"); b.apply(base);
    const oa = a.insert(1, "A"), ob = b.insert(1, "B");
    a.apply(ob); b.apply(oa);
    expect(a.text()).toBe(b.text());
    expect(a.text()).toBe("xBAy"); // equal counters; "bbbb…" > "aaaa…" goes first
  });
  it("applying an op twice is a no-op", () => {
    const a = new Rga("a".repeat(16)), b = new Rga("b".repeat(16));
    const op = a.insert(0, "hi");
    expect(b.apply(op)).toBe(true);
    expect(b.apply(op)).toBe(false);
    expect(b.text()).toBe("hi");
  });
  it("buffers an op whose anchor is unknown, then applies it when the anchor arrives", () => {
    const a = new Rga("a".repeat(16)), b = new Rga("b".repeat(16));
    const first = a.insert(0, "ab"), second = a.insert(2, "c");
    b.apply(second);
    expect(b.text()).toBe("");
    expect(b.pendingCount()).toBe(1);
    b.apply(first);
    expect(b.text()).toBe("abc");
    expect(b.pendingCount()).toBe(0);
  });
  it("delete vs undelete is last-writer-wins on the stamp", () => {
    const a = new Rga("a".repeat(16)), b = new Rga("b".repeat(16));
    const ins = a.insert(0, "x"); b.apply(ins);
    const del = a.delete(0, 1)!; b.apply(del);
    const und = b.undeleteIds([{ r: ins.k === "ins" ? ins.id.r : "", c: 1, n: 1 }]);
    a.apply(und);
    expect(a.text()).toBe("x");
    expect(b.text()).toBe("x");
  });
  it("indexOf works for tombstones; idAt/indexOf round-trip", () => {
    const a = new Rga("a".repeat(16));
    a.insert(0, "abc");
    const bId = a.idAt(1);
    a.delete(1, 1);
    expect(a.isVisible(bId)).toBe(false);
    expect(a.indexOf(bId)).toBe(1);
    expect(a.indexOf(a.idAt(1))).toBe(1);
  });
  it("never splits a surrogate pair: emoji insert/delete stay whole", () => {
    const a = new Rga("a".repeat(16));
    a.insert(0, "a🌮b");
    a.delete(1, 2);
    expect(a.text()).toBe("ab");
  });
});

describe("Rga convergence (property)", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])("random concurrent sessions converge (seed %i)", (seed) => {
    // 3 replicas; 200 random local inserts/deletes/undeletes, each op delivered to every other
    // replica in an independently shuffled order with ~20% duplicates; all texts must be equal
    // and pendingCount() 0 after delivery.
  });
});
```

  The property test's body is the executor's to write. Its contract is in the comment:
  - 3 replicas with distinct replica ids;
  - 200 random local ops;
  - per-receiver shuffled delivery, including duplicates;
  - assert equal text and zero pending.

- [ ] **Step 2: Run it.** `cd client && npx vitest run src/live/crdt`. Expected: FAIL, because
  `./rga` is missing.

- [ ] **Step 3: Implement `rga.ts`.** Internals are yours (a per-character linked list or runs).
  The algorithm points the tests do not fully force:
  - **Lamport:**
    - A local op uses `counter = max seen + 1`, and an insert of n chars consumes n counters.
    - A del/undel stamp consumes one counter.
    - Every applied remote op raises the max seen to its largest counter.
  - **Placement of `ins` (classic RGA):** find `after` (or the head). Scan right; while the next
    element's id compares greater than the new op's first id, skip it. Insert there. Characters of
    one op stay contiguous.
  - **Visibility:**
    - Each element stores its latest del/undel stamp.
    - A del/undel applies to an element only if its stamp compares greater than the stored one.
    - Visible = no stamp, or the latest stamp came from an `undel`.
  - **Buffering:**
    - An `ins` whose `after` is unknown is buffered.
    - A del/undel touching an unknown id is buffered.
    - Retry buffered ops after every successful apply.
  - **Idempotence:** an `ins` whose first id already exists is a no-op.
  - **Local `delete(index, count)`:** hides the visible elements in `[index, index+count)`, and
    `ranges` lists exactly those ids, merged into runs.
  - **Surrogates:** `insert`/`delete` callers pass UTF-16 indices at pair boundaries (Task 5
    guarantees this). `delete` must remove both halves when given them.

- [ ] **Step 4: Run it.** Same command. Expected: all PASS, including all 8 seeds.

- [ ] **Step 5: LEARNING.md.** Add these entries:
  - "CRDTs: convergence, commutativity, idempotence";
  - "RGA: ids, insert-after, tie-break, tombstones";
  - "Lamport clocks";
  - "Last-writer-wins registers (delete/undelete)";
  - "Testing: seeded property tests".

- [ ] **Step 6: Commit:** `feat(client): RGA sequence CRDT with tombstones, undelete and buffering`

---

### Task 3: RGA state (snapshots) and performance budgets

**Concept:**
- A snapshot is the whole CRDT, tombstones included, frozen to bytes, so joiners don't replay
  thousands of ops.
- It is stored forever (encrypted), so its format carries a version (`v: 1`).
- **Run-length encoding:** "1,000 characters typed in a row by one replica" becomes one entry,
  not 1,000.

**Files:**
- Modify: `client/src/live/crdt/rga.ts`, `client/src/live/crdt/rga.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RgaState { v: 1; /* compact, JSON-serialisable; shape is yours */ }
  // on Rga:
  toState(): RgaState;
  static fromState(replica: string, state: RgaState): Rga;   // Lamport max seen restored from state
  ```

- [ ] **Step 1: Add the failing tests:**

```ts
describe("Rga state", () => {
  it("round-trips text, tombstones and future convergence", () => {
    const a = new Rga("a".repeat(16)), b = new Rga("b".repeat(16));
    const o1 = a.insert(0, "hello world"); b.apply(o1);
    a.delete(0, 6);
    const restored = Rga.fromState("c".repeat(16), a.toState());
    expect(restored.text()).toBe("world");
    const late = b.insert(5, "!");               // anchored on the 'o' of "hello", which a deleted (a tombstone)
    restored.apply(late); a.apply(late);
    expect(restored.text()).toBe(a.text());
  });
  it("new local ops after fromState get counters above everything in the state", () => {
    const a = new Rga("a".repeat(16)); a.insert(0, "abc");
    const r = Rga.fromState("c".repeat(16), a.toState());
    const op = r.insert(3, "d");
    expect(op.k === "ins" && op.id.c).toBeGreaterThan(3);
  });
  it("is compact: a 1 MiB single-run note serialises under 1.2 MiB", () => {
    const a = new Rga("a".repeat(16)); a.insert(0, "x".repeat(1 << 20));
    expect(JSON.stringify(a.toState()).length).toBeLessThan(1.2 * (1 << 20));
  });
  it("heavy history fits the snapshot frame: 1 MiB visible + 1 MiB tombstones < 8 MiB as base64-sealed", () => {
    // 2 MiB inserted in 2,000 runs from 2 replicas, then every other run deleted
    // assert: JSON.stringify(state).length * 4 / 3 + 1024 < 8 << 20
  });
  it("stays fast: 2,000 single-char inserts at random spots in a 100 KB note < 300 ms", () => {
    // build 100 KB, then time 2,000 random-position insert(i, "k") calls with performance.now()
  });
});
```

- [ ] **Step 2: Run it.** `cd client && npx vitest run src/live/crdt/rga`. Expected: FAIL
  (`toState` missing).

- [ ] **Step 3: Implement** `toState` / `fromState` with run-length encoding of consecutive ids
  that share one replica, consecutive counters, adjacency, and the same visibility stamp. If the
  performance test fails, add an index (e.g. run-based chunks with cached visible lengths). Don't
  loosen the budget.

- [ ] **Step 4: Run all client checks.** `npx vitest run && npx tsc -b && npm run lint`. Expected:
  all pass.

- [ ] **Step 5: LEARNING.md.** Add "Snapshots and run-length encoding" and "Performance budgets in
  tests".

- [ ] **Step 6: Commit:** `feat(client): compact RGA snapshots within size and speed budgets`

---

### Task 4: Own-edits undo/redo

**Concept:**
- In a shared document, "undo" must mean *undo what I did*, not "go back in time". Going back in
  time would erase your friend's typing.
- So we record **my** ops and undo them by applying their inverse:
  - undoing an insert deletes those exact character ids;
  - undoing a delete un-deletes them.
- Because these are ordinary ops, they sync and converge like any edit.

**Files:**
- Create: `client/src/live/crdt/undo.ts`, `client/src/live/crdt/undo.test.ts`
- Modify: `LEARNING.md`

**Interfaces:**
- Consumes: `Rga`, `Op`, `IdRange` (Task 2).
- Produces:
  ```ts
  export interface UndoResult { ops: Op[]; caret: number }   // ops already applied to the Rga
  export class UndoManager {
    constructor(rga: Rga, groupMs?: number);   // default 500
    record(op: Op, now: number): void;         // every LOCAL edit op (not undo/redo output, not remote)
    breakGroup(): void;                        // e.g. caret moved by click/arrow
    undo(): UndoResult | null;
    redo(): UndoResult | null;
  }
  ```
- **Rules:**
  - **Grouping:** ops recorded less than `groupMs` after the previous one join its step.
    `breakGroup()` or a longer pause starts a new step.
  - **Undo:** inverts a step's ops in reverse order (`ins` → `deleteIds`, `del` → `undeleteIds`)
    and pushes it onto the redo stack.
  - **Redo:** re-applies the step (`ins` → `undeleteIds`, `del` → `deleteIds`).
  - Any new `record` clears the redo stack.
  - `caret` = the visible index just after the last affected character (for an undone insert,
    where it was).

- [ ] **Step 1: Write the failing tests:**

```ts
it("undo/redo a typing burst as one step", () => {
  const rga = new Rga("a".repeat(16)); const u = new UndoManager(rga, 500);
  u.record(rga.insert(0, "h"), 0); u.record(rga.insert(1, "i"), 100);
  expect(u.undo()!.caret).toBe(0); expect(rga.text()).toBe("");
  u.redo(); expect(rga.text()).toBe("hi");
});
it("a pause starts a new step", () => {
  const rga = new Rga("a".repeat(16)); const u = new UndoManager(rga, 500);
  u.record(rga.insert(0, "a"), 0); u.record(rga.insert(1, "b"), 1000);
  u.undo(); expect(rga.text()).toBe("a");
});
it("undoing a delete restores exactly those characters", () => {
  const rga = new Rga("a".repeat(16)); const u = new UndoManager(rga);
  u.record(rga.insert(0, "hello"), 0); u.breakGroup();
  u.record(rga.delete(1, 3)!, 1000); expect(rga.text()).toBe("ho");
  u.undo(); expect(rga.text()).toBe("hello");
});
it("never touches a collaborator's text, even in the same line", () => {
  const me = new Rga("a".repeat(16)), friend = new Rga("b".repeat(16)); const u = new UndoManager(me);
  const mine = me.insert(0, "mine "); u.record(mine, 0); friend.apply(mine);
  const theirs = friend.insert(5, "theirs"); me.apply(theirs);
  const res = u.undo()!;
  for (const op of res.ops) friend.apply(op);
  expect(me.text()).toBe("theirs"); expect(friend.text()).toBe("theirs");
});
it("undo revives text a collaborator also deleted", () => {
  const me = new Rga("a".repeat(16)), friend = new Rga("b".repeat(16)); const u = new UndoManager(me);
  const ins = me.insert(0, "keep"); friend.apply(ins); u.breakGroup();
  const del = me.delete(0, 4)!; u.record(del, 1000); friend.apply(del);
  const friendDel = friend.deleteIds([{ r: "a".repeat(16), c: 1, n: 4 }]); // friend deletes them too…
  me.apply(friendDel);                                                     // …and I see it before undoing
  const res = u.undo()!; for (const op of res.ops) friend.apply(op);       // my later stamp wins (LWW)
  expect(me.text()).toBe("keep"); expect(friend.text()).toBe("keep");
});
it("a new edit clears redo", () => {
  const rga = new Rga("a".repeat(16)); const u = new UndoManager(rga);
  u.record(rga.insert(0, "a"), 0); u.undo(); u.record(rga.insert(0, "b"), 2000);
  expect(u.redo()).toBeNull();
});
```

- [ ] **Step 2: Run it.** `npx vitest run src/live/crdt/undo`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `undo.ts` per the rules above.

- [ ] **Step 4: Run it.** Expected: PASS. Then the full client checks.

- [ ] **Step 5: LEARNING.md.** Add "Undo in collaborative editors (selective undo via inverse ops)".

- [ ] **Step 6: Commit:** `feat(client): own-edits undo and redo on the CRDT`

---

### Task 5: Textarea changes → splices; selection anchors

**Concept:**
- A textarea only tells you "the text is now X". We turn the difference between old and new into
  one **splice** (at index i, remove n, insert s), using the caret to settle ambiguous cases like
  "aa" → "aaa".
- A cursor saved as a number breaks when text is inserted before it. Saved as an **anchor** ("just
  after character id X"), it stays put.

**Files:**
- Create: `client/src/live/editing.ts`, `client/src/live/editing.test.ts`

**Interfaces:**
- Consumes: `Rga`, `ElemId`.
- Produces:
  ```ts
  export interface Splice { index: number; remove: number; insert: string }
  export function spliceFromChange(prev: string, next: string, caret: number): Splice | null; // caret = selectionEnd after the change
  export type Anchor = ElemId | null;                 // element just BEFORE the position; null = document start
  export function toAnchor(rga: Rga, index: number): Anchor;   // index 0 → null; else rga.idAt(index - 1)
  export function fromAnchor(rga: Rga, a: Anchor): number;     // null → 0; else indexOf(a) + (isVisible(a) ? 1 : 0)
  ```
- **Algorithm for `spliceFromChange`** (not forced by the signature):
  1. Common suffix `s`: compare from the end, but never past `next.length - caret`, and never past
     either string.
  2. Common prefix `p`: compare from the start, up to `min(prev.length, next.length) - s`.
  3. If both remainders are empty, return `null`.
  4. If `p` or the end of the removed or inserted region falls between a high and a low surrogate,
     move that boundary outward by one.

- [ ] **Step 1: Write the failing tests:**

```ts
it.each([
  ["", "a", 1, { index: 0, remove: 0, insert: "a" }],
  ["aa", "aaa", 1, { index: 0, remove: 0, insert: "a" }],       // caret disambiguates
  ["aa", "aaa", 3, { index: 2, remove: 0, insert: "a" }],
  ["hello", "hllo", 1, { index: 1, remove: 1, insert: "" }],
  ["teh cat", "the cat", 3, { index: 1, remove: 2, insert: "he" }], // autocorrect word replacement
  ["abc", "aXYc", 3, { index: 1, remove: 1, insert: "XY" }],       // paste over selection
  ["a🌮b", "ab", 1, { index: 1, remove: 2, insert: "" }],           // whole emoji
  ["a🌮b", "a🌯b", 3, { index: 1, remove: 2, insert: "🌯" }],       // shared high surrogate not split
])("%j -> %j (caret %i)", (prev, next, caret, want) => {
  expect(spliceFromChange(prev, next, caret)).toEqual(want);
});
it("no change → null", () => expect(spliceFromChange("x", "x", 1)).toBeNull());

it("anchors survive remote edits before, at and after them", () => {
  const me = new Rga("a".repeat(16)), them = new Rga("b".repeat(16));
  const base = me.insert(0, "hello world"); them.apply(base);
  const a = toAnchor(me, 6);                       // just before "w"
  me.apply(them.insert(0, ">> "));
  expect(fromAnchor(me, a)).toBe(9);
  me.apply(them.delete(3 + 5, 1)!);                 // delete the space before "w"
  expect(fromAnchor(me, a)).toBe(8);
  expect(fromAnchor(me, toAnchor(me, 0))).toBe(0);
});
```

- [ ] **Step 2: Run it.** `npx vitest run src/live/editing`. Expected: FAIL.

- [ ] **Step 3: Implement** `editing.ts`.

- [ ] **Step 4: Run it**, then the full client checks. Expected: PASS.

- [ ] **Step 5: LEARNING.md.** Add "Diffing input into operations" and "Anchors vs indices".

- [ ] **Step 6: Commit:** `feat(client): textarea splices and selection anchors`

---

### Task 6: Protocol types, sealed payloads, outbox

**Concept:**
- Every message has an outside the server reads (type, sequence number) and an inside it can't
  (the encrypted payload).
- Binding the **kind** into the AAD means a captured cursor message can't be replayed as an edit.
- The **outbox** keeps encrypted batches until the server acknowledges them, so closing the tab
  loses nothing.

**Files:**
- Create: `client/src/live/protocol.ts`, `client/src/live/sealed.ts`,
  `client/src/live/sealed.test.ts`, `client/src/live/outbox.ts`, `client/src/live/outbox.test.ts`

**Interfaces:**
- Consumes: `Op`, `RgaState` (Tasks 2–3), `Anchor` (Task 5), `utf8`/`toBase64`/`fromBase64`,
  `DecryptError`, `KeyValueStorage` (Phase 1 `notes/pending.ts`).
- Produces (`protocol.ts`):
  ```ts
  export interface SealedWire { ct: string; iv: string }               // standard base64
  export type ClientMsg =
    | { t: "hello"; have: number }
    | ({ t: "ops"; cid: string } & SealedWire)
    | ({ t: "presence" } & SealedWire)
    | ({ t: "snapshot"; upTo: number } & SealedWire)
    | { t: "ping" };
  export type ServerMsg =
    | { t: "welcome"; seq: number; here: number; snapshot: ({ upTo: number } & SealedWire) | null }
    | ({ t: "op"; seq: number } & SealedWire)
    | { t: "ack"; cid: string; seq: number }
    | { t: "synced"; seq: number }
    | ({ t: "presence"; from: number } & SealedWire)
    | { t: "left"; from: number }
    | { t: "here"; n: number }
    | { t: "pong" };
  export interface OpsPayload { v: 1; at: number; r: string; color: string; ops: Op[] }
  export interface PresencePayload { v: 1; r: string; color: string; anchor: Anchor; head: Anchor }
  export interface SnapshotPayload { v: 1; state: RgaState }
  export const CLOSE_ROOM_FULL = 4001, CLOSE_BAD_MESSAGE = 4400, CLOSE_TOO_SLOW = 4008;
  ```
- Produces (`sealed.ts`, `outbox.ts`):
  ```ts
  export type SealKind = "ops" | "presence" | "snapshot";
  export function seal(key: CryptoKey, noteId: string, kind: SealKind, value: unknown): Promise<SealedWire>;
  export function unseal<T>(key: CryptoKey, noteId: string, kind: SealKind, s: SealedWire): Promise<T>; // DecryptError on any failure
  export interface OutboxItem { cid: string; ct: string; iv: string }
  export interface Outbox { list(noteId: string): OutboxItem[]; add(noteId: string, item: OutboxItem): void; remove(noteId: string, cid: string): void }
  export function createOutbox(storage: KeyValueStorage): Outbox;   // key "outbox:<id>", JSON array; corrupt → []
  ```

- [ ] **Step 1: Write the failing tests:**

```ts
// sealed.test.ts
it("round-trips a payload", async () => {
  const s = await seal(key, ID, "ops", { v: 1, hello: "🌮" });
  expect(await unseal(key, ID, "ops", s)).toEqual({ v: 1, hello: "🌮" });
});
it("a presence message cannot be opened as ops (kind in AAD)", async () => {
  const s = await seal(key, ID, "presence", { v: 1 });
  await expect(unseal(key, ID, "ops", s)).rejects.toBeInstanceOf(DecryptError);
});
it("a message for another note fails", async () => {
  const s = await seal(key, ID, "ops", {});
  await expect(unseal(key, "b".repeat(43), "ops", s)).rejects.toBeInstanceOf(DecryptError);
});
it("fresh IV every time", async () => {
  expect((await seal(key, ID, "ops", 1)).iv).not.toBe((await seal(key, ID, "ops", 1)).iv);
});
// outbox.test.ts
it("adds, lists in order, removes by cid; stores only ct/iv/cid", () => {
  const storage = memoryStorage(); const ob = createOutbox(storage);
  ob.add(ID, { cid: "1", ct: "Y3Q=", iv: "aXY=" }); ob.add(ID, { cid: "2", ct: "Y3Q=", iv: "aXY=" });
  ob.remove(ID, "1");
  expect(ob.list(ID).map((i) => i.cid)).toEqual(["2"]);
  expect(JSON.parse(storage.getItem(`outbox:${ID}`)!)).toEqual([{ cid: "2", ct: "Y3Q=", iv: "aXY=" }]);
});
it("corrupt storage reads as empty", () => {
  const storage = memoryStorage(); storage.setItem(`outbox:${ID}`, "{nope");
  expect(createOutbox(storage).list(ID)).toEqual([]);
});
```

- [ ] **Step 2: Run them.** `npx vitest run src/live/sealed src/live/outbox`. Expected: FAIL.

- [ ] **Step 3: Implement** `protocol.ts` (types and constants only), `sealed.ts` (AAD =
  `utf8(`${noteId}|${kind}`)`, JSON plaintext), and `outbox.ts`. A quota error on `setItem` is
  swallowed, as in Phase 1's pending store.

- [ ] **Step 4: Run them.** Expected: PASS, then the full client checks.

- [ ] **Step 5: LEARNING.md.** Add "Wire format: outside vs inside an encrypted message" and "AAD
  binding to stop cross-kind replay".

- [ ] **Step 6: Commit:** `feat(client): live protocol types, kind-bound sealing, ciphertext outbox`

---

### Task 7: Server op log storage

**Concept:**
- An **append-only log** with a per-note counter is the backbone of event sourcing. The server
  doesn't need to understand ops to order and store them.
- SQLite has one writer at a time. Our single process serializes `AppendOp` with a mutex, and the
  `(note_id, seq)` primary key is the backstop that makes a duplicate seq impossible.
- Snapshots are accepted only if they move forward.

**Files:**
- Create: `server/internal/noteid/noteid.go`, `server/internal/noteid/noteid_test.go`,
  `server/internal/store/oplog.go`, `server/internal/store/oplog_contract_test.go`,
  `server/internal/store/migrations/002_ops.sql`
- Modify: `server/internal/store/memory.go`, `server/internal/store/sqlite.go`,
  `server/internal/store/memory_test.go`, `server/internal/store/sqlite_test.go`,
  `server/internal/httpapi/api.go` (use `noteid.Valid`), `LEARNING.md`

**Interfaces:**
- Produces:
  ```go
  package noteid
  func Valid(id string) bool // ^[A-Za-z0-9_-]{43}$

  package store
  type StoredOp struct { Seq int64; Ciphertext, IV []byte; CreatedAt time.Time }
  type Snapshot struct { UpToSeq int64; Ciphertext, IV []byte; CreatedAt time.Time }
  type OpLog interface {
      AppendOp(ctx context.Context, noteID string, ciphertext, iv []byte) (StoredOp, error) // seq = previous max + 1, starting at 1
      OpsAfter(ctx context.Context, noteID string, afterSeq int64, limit int) ([]StoredOp, error) // ascending seq
      LatestSeq(ctx context.Context, noteID string) (int64, error)                               // 0 if none
      PutSnapshot(ctx context.Context, noteID string, upToSeq int64, ciphertext, iv []byte) (bool, error)
      LatestSnapshot(ctx context.Context, noteID string) (Snapshot, error)                       // ErrNotFound if none
  }
  // *Memory and *SQLite implement OpLog (compile-time assertions).
  ```
- `PutSnapshot` accepts (true) only if `upToSeq <= LatestSeq` and `upToSeq` > the current latest
  snapshot's `UpToSeq` (or there is none). It keeps every accepted row.

- [ ] **Step 1: Write the migration** `002_ops.sql`:

```sql
-- Encrypted CRDT operations, in server-assigned order. Never deleted (Phase 3 history).
CREATE TABLE ops (
  note_id     TEXT    NOT NULL,
  seq         INTEGER NOT NULL,   -- 1, 2, 3 … per note
  ciphertext  BLOB    NOT NULL,
  iv          BLOB    NOT NULL,
  created_at  INTEGER NOT NULL,   -- unix ms
  PRIMARY KEY (note_id, seq)
);
-- Client-made encrypted snapshots of the CRDT state. All kept.
CREATE TABLE snapshots (
  note_id     TEXT    NOT NULL,
  up_to_seq   INTEGER NOT NULL,
  ciphertext  BLOB    NOT NULL,
  iv          BLOB    NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (note_id, up_to_seq)
);
```

- [ ] **Step 2: Write the failing tests:**
  - `noteid_test.go`: a table test covering a valid 43-char id, 42 chars, 44 chars, and `!` in the
    id.
  - `oplog_contract_test.go`: `runOpLogContract(t, newLog func(t *testing.T) OpLog)`, wired into
    `TestMemoryOpLog` and `TestSQLiteOpLog`. Subtests:
    - `"append assigns 1, 2, 3 per note, independently per note"`
    - `"OpsAfter returns ascending ops after the seq, honouring limit"`
    - `"LatestSeq is 0 for an empty note"`
    - `"20 concurrent appends get exactly seqs 1..20"`
    - `"snapshot: accepted when newer and <= latest seq; rejected when stale or ahead of the log"`
    - `"LatestSnapshot returns ErrNotFound, then the newest accepted"`
    - `"stored bytes are copies (mutating the input after append changes nothing)"`
  - `sqlite_test.go`: add `"ops survive reopen"`.

- [ ] **Step 3: Run them.** `cd server && go test ./internal/noteid/ ./internal/store/`. Expected:
  FAIL (undefined symbols).

- [ ] **Step 4: Implement.**
  - `noteid`; switch `httpapi` to it (delete its local regex).
  - The `OpLog` methods on `Memory` (map + mutex) and `SQLite`:
    - `AppendOp` takes a `sync.Mutex`, then runs
      `INSERT … SELECT ?, COALESCE(MAX(seq),0)+1, … FROM ops WHERE note_id = ? RETURNING seq`.
    - Use `nowMilli()` for timestamps.

- [ ] **Step 5: Run them.** `cd server && gofmt -l . ; go vet ./... && go test ./...`. Expected:
  all ok. `gofmt -l` may list CRLF-only files in this Windows checkout; only files you changed
  matter.

- [ ] **Step 6: LEARNING.md.** Add "Event sourcing: append-only logs" and "Serializing writers:
  mutex + primary key backstop".

- [ ] **Step 7: Commit:** `feat(server): encrypted op log and snapshot storage`

---

### Task 8: Server live hub — join, catch-up, ops, ack, heartbeat

**Concept:**
- **HTTP vs WebSocket:** HTTP is one request and one response. A WebSocket starts as HTTP and is
  then *upgraded* into a two-way pipe that stays open.
- **Concurrency per connection:**
  - one goroutine reads;
  - one goroutine writes from a buffered **channel**;
  - `select` waits on "a message to send", "time to ping" and "context cancelled" at once.
- **Fan-out:** a room holds its peers. Broadcasting is a **non-blocking** channel send to each
  peer.
- **Two timeout traps:**
  - `http.Server`'s Read/Write timeouts set deadlines on the raw connection. After the upgrade the
    library keeps that connection, deadlines included, so we must clear them, or every live note
    dies after 15 s.
  - The library finds the raw connection through our logger's `Unwrap()`, the Phase 1 fix.

**Files:**
- Create: `server/internal/live/messages.go`, `server/internal/live/hub.go`,
  `server/internal/live/hub_test.go`
- Modify: `server/go.mod`, `server/go.sum`, `LEARNING.md`

**Interfaces:**
- Consumes: `store.OpLog` (Task 7), `noteid.Valid`, `httpapi.Logging` (in tests).
- Produces:
  ```go
  package live
  type Options struct {
      MaxPeers         int           // 20
      SendBuffer       int           // 64 messages per peer
      PingInterval     time.Duration // 30s (WebSocket-level ping)
      MaxOpBytes       int           // 256 << 10 (decoded ciphertext)
      MaxSnapshotBytes int           // 8 << 20 (decoded ciphertext)
      CatchUpPage      int           // 200 ops per OpsAfter call
  }
  func DefaultOptions() Options
  func NewHub(log store.OpLog, logger *slog.Logger, opts Options) *Hub
  func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) // expects r.PathValue("id")
  ```
- **Wire format:** the JSON of `client/src/live/protocol.ts` (Task 6), with identical field names.
  `messages.go` mirrors it with struct tags. Ciphertext and IV are standard base64 strings.
- **Behaviour:**
  1. **Invalid id:** HTTP 400 JSON before any upgrade.
  2. **Upgrade:** clear deadlines with
     `rc := http.NewResponseController(w); rc.SetReadDeadline(time.Time{}); rc.SetWriteDeadline(time.Time{})`,
     then `websocket.Accept` with default origin checking. Set the read limit to
     `MaxSnapshotBytes*4/3 + 4096`.
  3. **Join:** the first message must be `hello`; anything else closes with 4400. The peer joins
     the room *before* the server reads the log (so no broadcast is missed; duplicates are fine,
     because the client is idempotent).
  4. **Catch-up:**
     - Send `welcome{seq: LatestSeq, here, snapshot}`. Include the snapshot only when `have == 0`
       and one exists.
     - Then stream `op` messages for every seq above `max(have, snapshot.upTo)`, up to and
       including `welcome.seq`, paging by `CatchUpPage`.
     - Then send `synced{seq: welcome.seq}`.
  5. **`ops`:**
     - Validate: base64, IV exactly 12 bytes, ciphertext 16..MaxOpBytes bytes; otherwise close
       4400.
     - Call `AppendOp`, reply `ack{cid, seq}` to the sender, and broadcast `op{seq, ct, iv}` to the
       *other* peers.
  6. **`ping`:** reply `pong`.
  7. **Server keepalive:** the writer goroutine sends a WebSocket `Ping` every `PingInterval`. A
     failure ends the peer.
  8. **Errors:** any store error closes with `StatusInternalError` and logs; the client reconnects.

- [ ] **Step 1: Add the dependency.** `cd server && go get github.com/coder/websocket@v1.8.15`.
  Expected: `go.mod` requires it, and the go directive stays `1.24`.

- [ ] **Step 2: Write the failing tests** in `hub_test.go`.
  - **Helpers:**
    - `newTestServer(t, opts) (url string, log *store.Memory)` mounts
      `mux.Handle("GET /api/notes/{id}/live", httpapi.Logging(discard)(hub))` on
      `httptest.NewServer`.
    - `dial(t, url, id) *websocket.Conn`, plus `send` and `recv` helpers using `wsjson`, with a
      2-second context per call.
  - **Tests:**
    - `TestJoinEmptyNote`: hello{0} → welcome{seq:0, here:1, snapshot:nil} then synced{0}.
    - `TestOpsAreAckedAndBroadcast`:
      - A and B join; A sends ops{cid:"c1"}.
      - A receives ack{c1, 1}; B receives op{1, same ct/iv}.
      - A does NOT receive op 1.
    - `TestCatchUpFromZeroUsesLatestSnapshot`:
      - Seed ops 1..5, a snapshot upTo 3, ops 6..7.
      - hello{0} → welcome{seq:7, snapshot.upTo:3}, then op 4,5,6,7, then synced{7}.
    - `TestCatchUpFromHaveSkipsSnapshot`: seed ops 1..5; hello{2} → welcome{snapshot:nil}, then
      op 3,4,5, then synced{5}.
    - `TestCatchUpPages`: CatchUpPage=2 with 5 ops; all 5 arrive in order.
    - `TestRejectsBadMessages`: each case closes with 4400:
      - ops before hello;
      - IV of 11 bytes;
      - ciphertext over MaxOpBytes (set to 1024 in the test);
      - non-base64.
    - `TestInvalidIDIs400`: plain HTTP GET with a short id → 400.
    - `TestPingPong`: ping → pong.
    - `TestConnectionOutlivesServerTimeouts`:
      - Real `http.Server{ReadTimeout: 200ms, WriteTimeout: 200ms, Handler: Logging(mux)}` on a
        `net.Listen("tcp", "127.0.0.1:0")`.
      - Join, sleep 1s, ping → pong, and ops still acked.

- [ ] **Step 3: Run them.** `cd server && go test ./internal/live/`. Expected: FAIL (undefined
  `NewHub`).

- [ ] **Step 4: Implement** `messages.go` and `hub.go`:
  - **Structure:**
    - `Hub{mu sync.Mutex; rooms map[string]*room}`.
    - `room{peers map[*peer]struct{}; nextID int}`.
    - `peer{id int; send chan []byte (cap SendBuffer); cancel context.CancelFunc}`.
    - Rooms are deleted when empty.
  - **Lifecycle:** the read loop runs in `ServeHTTP`'s goroutine; the writer is a separate goroutine
    with `select`. On return, leave the room and cancel.

- [ ] **Step 5: Run them.** `cd server && go vet ./... && go test ./...`. Expected: all ok. Run the
  live tests 5 times (`go test -count=5 ./internal/live/`) to catch flakiness.

- [ ] **Step 6: LEARNING.md.** Add these entries:
  - "WebSockets vs HTTP";
  - "Goroutine per connection + writer goroutine";
  - "Channels and select";
  - "Fan-out without blocking";
  - "Long-lived connections vs server timeouts (ResponseController deadlines)";
  - "Unwrap and hijacking".

- [ ] **Step 7: Commit:** `feat(server): live WebSocket hub with catch-up, acks and heartbeat`

---

### Task 9: Server live hub — presence, viewer count, limits, slow clients; mount; PUT → 410

**Concept:**
- **Back-pressure:** if one friend's phone is on a terrible connection, its send queue fills up.
  Waiting for it would freeze everyone, so we **drop that one client** (it reconnects and catches
  up).
- **Presence** is relayed, never stored, because it's ephemeral.
- The viewer count is the one thing the server knows anyway (connections), so it sends it in
  plaintext.

**Files:**
- Modify: `server/internal/live/hub.go`, `server/internal/live/hub_test.go`,
  `server/internal/httpapi/api.go`, `server/internal/httpapi/api_test.go`,
  `server/cmd/server/main.go`, `server/cmd/server/main_test.go`, `LEARNING.md`

**Interfaces:**
- Consumes: Task 8's hub.
- **Behaviour added:**
  1. **`presence{ct, iv}`:**
     - Validate base64, IV of 12 bytes, ciphertext ≤ 4096 bytes.
     - Broadcast `presence{from: peer.id, ct, iv}` to the others. Never stored.
  2. **Viewer count:** after a peer joins (after its `welcome`) or leaves, send `here{n}` to every
     peer in the room. On leave, also broadcast `left{from: id}`.
  3. **Room full:** a join when the room holds `MaxPeers` closes with 4001 `"note is busy"` before
     `welcome`.
  4. **`snapshot{upTo, ct, iv}`:** validate (ciphertext ≤ MaxSnapshotBytes), then `PutSnapshot`.
     No reply. A rejected snapshot is not an error.
  5. **Slow client:** a broadcast that finds a peer's send channel full closes that peer with 4008
     and removes it; the others are unaffected.
  6. **`main.go`:** `newMux` mounts
     `mux.Handle("GET /api/notes/{id}/live", live.NewHub(st, logger, live.DefaultOptions()))`.
  7. **`httpapi`:** `PUT /api/notes/{id}` now always returns **410** with
     `{"error":"this note moved to live editing; reload the page"}`. GET is unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `hub_test.go`:
    - `TestPresenceRelayedNotStored`:
      - A, B join; A sends presence; B receives presence{from: A's id, same ct}.
      - Afterwards `LatestSeq` is still 0.
    - `TestHereCountsJoinAndLeave`: A joins (welcome.here 1); B joins → A gets here{2}; B closes →
      A gets left{B id} and here{1}.
    - `TestRoomFull`: MaxPeers=2; the third dial gets close code 4001.
    - `TestSnapshotStored`: after 3 ops, snapshot{upTo:3} → `LatestSnapshot.UpToSeq == 3`.
    - `TestSlowClientDropped`:
      - SendBuffer=2, MaxOpBytes=64KiB; C joins and never reads.
      - A sends 50 ops of 60 KiB.
      - B (reading) receives all 50.
      - C's connection is closed (its read eventually errors) and A still gets acks.
  - `api_test.go`: replace the PUT round-trip, validation and conflict tests with
    `TestPutIsGone` (410 with the message above). Rewrite the GET tests to seed through
    `store.Memory.PutNote` directly.
  - `main_test.go`: in `TestNewMuxRoutesAPIAndSPA`, assert that `GET /api/notes/<valid id>/live`
    without upgrade headers is not 404 (the hub answers 426/400), and that `PUT` returns 410.

- [ ] **Step 2: Run them.** `cd server && go test ./...`. Expected: FAIL on the new tests.

- [ ] **Step 3: Implement** the behaviour above.

- [ ] **Step 4: Run them.** `go vet ./... && go test ./... && go test -count=5 ./internal/live/`.
  Expected: all ok.

- [ ] **Step 5: LEARNING.md.** Add "Back-pressure: drop the slow consumer" and "Ephemeral vs
  durable messages".

- [ ] **Step 6: Commit:** `feat(server): presence relay, viewer count, room limits; legacy PUT is gone`

---

### Task 10: LiveNote engine — sync core

**Concept:**
- **Local-first:** every keystroke updates the local CRDT and screen *immediately*. The network is
  a background job that batches, encrypts, stores in the outbox, sends, and waits for the ack.
- **Reconnect and catch-up:**
  - The client remembers `have`, the largest seq N such that it has *all* of 1..N.
  - It catches up from there.
  - It resends whatever is still in its outbox.
- The CRDT's idempotence turns every duplicate into a no-op.

**Files:**
- Create: `client/src/live/liveNote.ts`, `client/src/live/liveNote.test.ts`,
  `client/src/live/testing/fakeHub.ts`
- Modify: `LEARNING.md`

**Interfaces:**
- Consumes: `Rga` (Tasks 2–3), `spliceFromChange` / `toAnchor` / `fromAnchor` (Task 5),
  `seal` / `unseal` / `Outbox` / protocol types (Task 6), `NoteKeys`, `NotesApi["getNote"]`,
  `PendingStore`.
- Produces:
  ```ts
  export interface Socket { send(msg: ClientMsg): void; close(): void }
  export interface SocketHandlers { onOpen(): void; onMessage(msg: ServerMsg): void; onClose(code: number): void }
  export type Connect = (noteId: string, handlers: SocketHandlers) => Socket;

  export type LiveStatus =
    | { kind: "deriving" } | { kind: "connecting" } | { kind: "ready" }
    | { kind: "unreadable" } | { kind: "error"; message: string };
  export interface RemoteCursor { from: number; color: string; start: number; end: number }
  export interface LiveSnapshot {
    status: LiveStatus;
    text: string;
    selection: { start: number; end: number };          // where the local caret must be
    conn: "live" | "connecting" | "offline" | "busy";
    here: number;                                        // includes me; 0 until welcome
    cursors: RemoteCursor[];                             // Task 11
    full: boolean;                                       // Task 11
    unsent: number;                                      // outbox length + unbatched edits
  }
  export interface LiveNoteDeps {
    connect: Connect;
    api: Pick<NotesApi, "getNote">;                      // Task 12 (legacy import)
    outbox: Outbox;
    legacyPending: PendingStore;                         // Task 12
    derive: (name: string) => Promise<NoteKeys>;
    replica?: string;                                    // default: 16 random hex chars
    now?: () => number;                                  // default Date.now
    batchMs?: number;                                    // 50
    presenceMs?: number;                                 // 50 (Task 11)
    snapshotEvery?: number;                              // 500 (Task 11)
    maxTextBytes?: number;                               // 1 << 20 (Task 11)
    heartbeatMs?: number;                                // 25_000
    pongTimeoutMs?: number;                              // 10_000
  }
  export class LiveNote {
    constructor(name: string, deps: LiveNoteDeps);
    subscribe: (l: () => void) => () => void;
    getSnapshot: () => LiveSnapshot;
    start(): Promise<void>;
    dispose(): void;                                       // flushes the batch into the outbox, closes the socket
    change: (next: string, selStart: number, selEnd: number) => void;  // textarea changed
    select: (start: number, end: number) => void;          // caret moved (Task 11 adds presence)
    retryNow: () => void;                                  // e.g. browser "online"
    hasUnsentWork: () => boolean;
    // Task 11: undo, redo, setComposing
  }
  ```
- `fakeHub.ts` (test-only; same semantics as the Go hub; no encryption of its own):
  ```ts
  export class FakeHub {
    online: boolean;                       // false → connect() calls onClose(1006) asynchronously
    log: { seq: number; ct: string; iv: string }[];
    snapshots: { upTo: number; ct: string; iv: string }[];
    holdAcks: boolean;                     // true → ops are stored and broadcast, acks withheld
    connect: Connect;
    dropAll(): void;                       // closes every socket with 1006
    silence(): void;                       // stops replying (pong, acks, broadcasts) without closing: a dead socket
    peers(): number;
  }
  ```
- **Engine rules:**
  - **`start`:** derive keys → status connecting → connect → `hello{have}`. On `welcome` with a
    snapshot, load the state via `Rga.fromState`. Apply each `op` (unseal → apply ops). On
    `synced`, status becomes ready (first time).
  - **`change`:** call `spliceFromChange(prev, next, selEnd)`, then `rga.delete` / `rga.insert`,
    then queue the ops. A batch flushes after `batchMs`: seal as `OpsPayload`, `outbox.add`, and
    send if connected.
  - **`ack`:** `outbox.remove`, then mark the seq as received.
  - **`have`:** the largest N with every seq ≤ N received (from ops, acks, or `synced`, which sets
    `have = max(have, seq)`).
  - **Remote apply:** before applying, take the selection as anchors; after, restore it into
    `snapshot.selection`.
  - **Reconnect:** on close (except 4001) use backoff 1 s → 30 s. A 4001 close sets
    `conn: "busy"` and keeps the backoff. On `open`, send `hello{have}` and then every outbox item,
    in order.
  - **Heartbeat:** send `ping` every `heartbeatMs`. No `pong` within `pongTimeoutMs` → close and
    reconnect.
  - **Undecryptable data:** an `op` or snapshot that fails `unseal` puts the status to
    `unreadable`. Edits are refused.

- [ ] **Step 1: Write the failing tests** in `liveNote.test.ts`. Use fake timers for `setTimeout`
  / `clearTimeout` / `setInterval` / `clearInterval` only, and an `until()` helper using the real
  `setImmediate` (the Phase 1 `noteSync.test.ts` pattern). Two engines plus one `FakeHub` simulate
  two friends.
  - `"a new note opens empty and live"` → status ready, conn live, here 1, text "".
  - `"typing appears for the friend after the batch interval"`: A changes "" → "hi" with caret 2;
    after 50 ms B's text is "hi"; A's outbox is empty after the ack.
  - `"both type at once in the same line and converge"`: concurrent changes, flushed together,
    give equal texts containing both edits.
  - `"a remote insert before my caret keeps my caret on the same character"`: A's text "hello
    world" with selection (6,6); B inserts ">> " at 0; A's `snapshot.selection` becomes (9,9).
  - `"offline typing is kept in the outbox and merges on reconnect"`:
    - hub offline; A types "offline words".
    - Its conn is offline, `unsent > 0` and the outbox holds the ciphertext. The outbox JSON does
      not contain "offline".
    - Go back online and advance through the backoff: B's text contains "offline words", and the
      outbox is empty.
  - `"server restart mid-session: reconnect with have, catch up, nothing lost"`:
    - `hub.dropAll()`; B types while A is disconnected.
    - A reconnects: the hello carries `have` equal to the last contiguous seq, and A ends with B's
      text.
  - `"a dead socket is detected by the heartbeat"`: `hub.silence()`; advance 25 s + 10 s; A's conn
    is connecting/offline and it has reconnected (`hub.peers()` counts a new socket after the hub
    resumes).
  - `"dispose with unbatched edits writes them to the outbox"`: change, then immediately dispose;
    the outbox has 1 item.
  - `"two tabs sharing one outbox don't duplicate text"`:
    - A and A2 share the same `Outbox` storage. A types offline, then is disposed.
    - A2 starts online: B's text contains the offline words exactly once.
  - `"an undecryptable op makes the note unreadable and refuses edits"`: push garbage ct into the
    hub log and join; status unreadable; `change` does nothing.

- [ ] **Step 2: Run them.** `npx vitest run src/live/liveNote`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `fakeHub.ts`, then `liveNote.ts`, following the rules above. Keep the
  Phase 1 run-counter pattern so stale async work after `dispose`/`start` is ignored.

- [ ] **Step 4: Run them.** Run the suite 3 times. Expected: all PASS every time. Then run the full
  client checks.

- [ ] **Step 5: LEARNING.md.** Add these entries:
  - "Local-first editing";
  - "Contiguous sequence tracking (have)";
  - "Outbox + ack = at-least-once; idempotence = exactly-once in effect";
  - "Heartbeats detect dead connections".

- [ ] **Step 6: Commit:** `feat(client): LiveNote sync engine with outbox, catch-up and reconnect`

---

### Task 11: LiveNote — presence, undo/redo, size limit, snapshots, IME

**Concept:**
- **Presence** is a tiny, throttled, encrypted "my cursor is just after character X" message.
  Throttling means at most one per 50 ms, so dragging a selection doesn't flood the room.
- **Snapshots are made by clients**, but only from a state that is *fully shared*. Otherwise a
  joiner could see text that existing peers never received.
- **IME composition** (phone keyboards, CJK input) breaks if the text changes underneath it, so
  remote edits wait until composition ends.

**Files:**
- Modify: `client/src/live/liveNote.ts`, `client/src/live/liveNote.test.ts` (or
  `liveNote.presence.test.ts`), `LEARNING.md`

**Interfaces:**
- Consumes: `UndoManager` (Task 4), `PresencePayload`, `SnapshotPayload`.
- Produces (added to `LiveNote`):
  ```ts
  undo: () => void;
  redo: () => void;
  setComposing: (composing: boolean) => void;
  ```
- **Rules:**
  1. **Presence:**
     - Send on `select`/`change`, throttled to `presenceMs`.
     - Also re-send when `here` increases, so newcomers see cursors.
     - Colour: random per visit from a fixed 8-colour palette chosen by the executor.
     - Received presence becomes `cursors` (indices via `fromAnchor`, recomputed after every
       remote or local apply); remove it on `left`.
     - Own presence is never shown.
  2. **Undo/redo:** `change` records its ops in an `UndoManager`, and `select` calls
     `breakGroup()`. `undo`/`redo` apply the result: send its ops like any edit and set
     `selection` to `{caret, caret}`.
  3. **Size limit:**
     - A `change` whose resulting UTF-8 length exceeds `maxTextBytes` *and* that grows the text is
       refused: the text stays, `full: true`.
     - The next accepted change clears `full`. Deletions are always accepted.
  4. **Snapshot upload:**
     - Condition: `have − lastSnapshotUpTo ≥ snapshotEvery`, *and* the outbox is empty, *and* no
       unbatched edits, *and* no received seq above `have`.
     - Action: send `snapshot{upTo: have}` sealed `SnapshotPayload`, then set
       `lastSnapshotUpTo = have`.
     - `lastSnapshotUpTo` starts at `welcome.snapshot?.upTo ?? 0`.
  5. **IME:**
     - While `setComposing(true)`, remote ops are buffered (not applied).
     - `setComposing(false)` applies them, with selection preservation.
     - Local `change` still applies during composition.

- [ ] **Step 1: Write the failing tests:**
  - `"my cursor appears for the friend and follows edits"`:
    - A selects (2,4); after 50 ms B's `cursors` has one entry {start 2, end 4}.
    - B inserts at 0; B's cursor entry shifts to (3,5).
  - `"a leaving friend's cursor disappears; here updates"`: dispose B → A has `cursors` [] and here
    1.
  - `"undo removes only my text while the friend types in the same line"`: A types "mine ", B types
    "theirs" after it, A undo → both texts "theirs".
  - `"redo brings it back for everyone"`.
  - `"a paste past 1 MiB is refused and flagged full; deleting clears it"`: use `maxTextBytes: 10`.
  - `"uploads a snapshot only from fully shared state"`:
    - `snapshotEvery: 5`; B sends 5 ops → A uploads `snapshot{upTo: 5}`.
    - With `hub.holdAcks` true and A's own unacked edit pending, no upload happens.
  - `"remote edits wait while composing, then apply"`.

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement** the rules.

- [ ] **Step 4: Run them**, 3 times, then the full client checks. Expected: PASS.

- [ ] **Step 5: LEARNING.md.** Add "Presence and throttling", "Consistent snapshots", and "IME
  composition".

- [ ] **Step 6: Commit:** `feat(client): presence cursors, own-edits undo, size limit, snapshots, IME-safe`

---

### Task 12: LiveNote — importing Phase 1 notes and unsent Phase 1 text

**Concept:**
- Two people opening an old note at the same moment must not get the text twice.
- The trick is **deterministic ids**:
  - an import always uses the reserved replica `"0000000000000000"`;
  - character i gets counter i + 1.
- Both importers therefore produce *identical* ops, and idempotence keeps one copy.
- The same ids let us apply leftover Phase 1 text precisely, even after others have edited.

**Files:**
- Create: `client/src/live/importLegacy.ts`, `client/src/live/importLegacy.test.ts`
- Modify: `client/src/live/liveNote.ts`, `client/src/live/liveNote.test.ts`, `LEARNING.md`

**Interfaces:**
- Consumes: `Rga`, `IMPORT_REPLICA`, `spliceFromChange`, `decryptNote`, `NotesApi.getNote`,
  `PendingStore`.
- Produces:
  ```ts
  export function importOps(text: string, chunkChars?: number): Op[]; // default chunkChars 65_536; deterministic
  export function legacySpliceOps(legacyText: string, pendingText: string, rga: Rga): Op[]; // local ops via rga (applied)
  ```
- **Rules:**
  - **`importOps`:** chunk k inserts `text.slice(k*m, (k+1)*m)` with
    `id = { c: k*m + 1, r: IMPORT_REPLICA }` and `after` = the id of the previous chunk's last
    character (`null` for the first). Never split a surrogate pair at a chunk edge (shorten the
    chunk by one).
  - **`legacySpliceOps`:**
    - Take `s = spliceFromChange(legacyText, pendingText, 0)`. Caret 0 makes the common suffix
      as long as possible, so only the real change is applied.
    - Delete the import ids `c ∈ [s.index+1, s.index+s.remove]` via `rga.deleteIds`.
    - Insert `s.insert` after import id `c = s.index` (or at the start), using a local insert at
      `fromAnchor(rga, thatId)`.
  - **In `LiveNote`, after the first `synced`:**
    - If `seq === 0`, there was no snapshot, and the document is empty: call `api.getNote(id)`.
      - Not found → done.
      - Found → decrypt (failure → unreadable), then apply `importOps` locally and send them as
        ordinary batches (each chunk ≤ 256 KiB sealed).
    - Then, independently of who imported: if `legacyPending.load(id)` exists and the legacy blob
      was fetched and decrypted, apply `legacySpliceOps(legacy, pending, rga)`, send, and
      `legacyPending.clear(id)`.
    - A pending entry that fails to decrypt is cleared.
    - The legacy fetch also happens when `seq > 0` but a pending entry exists (it is needed as the
      diff base).

- [ ] **Step 1: Write the failing tests:**
  - `importLegacy.test.ts`:
    - `"import is deterministic (same ops for the same text)"`.
    - `"two replicas importing concurrently converge to one copy"`: both apply both import op lists,
      and the text equals the legacy text once.
    - `"chunks never split a surrogate pair"`: chunkChars 3 on "ab🌮cd".
    - `"legacySpliceOps applies unsent text on top of later edits"`:
      - Import "hello world"; a friend inserts "big " at 6.
      - `legacySpliceOps("hello world", "hello brave world", rga)` → "hello brave big world" or
        "hello big brave world". Assert that both "brave" and "big" are present exactly once, and
        that "hello " is a prefix.
  - `liveNote.test.ts`:
    - `"opening a Phase 1 note imports it once even with two simultaneous openers"`: the fake
      `getNote` returns an encrypted blob; A and B start together; both texts equal the legacy
      text.
    - `"unsent Phase 1 text in pending:<id> is merged and the entry removed"`.
    - `"an unreadable legacy blob makes the note unreadable"`.

- [ ] **Step 2: Run them.** Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run them**, then the full client checks. Expected: PASS.

- [ ] **Step 5: LEARNING.md.** Add "Deterministic ids for idempotent migrations".

- [ ] **Step 6: Commit:** `feat(client): import Phase 1 notes and unsent text without duplicates`

---

### Task 13: UI — WebSocket transport, hook, editor, cursors; remove Phase 1 sync

**Concept:**
- React stays thin. The engine says *what* the text and selection are, and the component makes
  the DOM match: `setSelectionRange` in a layout effect, so the caret is placed before paint.
- **Remote cursors over a textarea:** a hidden "mirror" element with identical font, padding and
  width tells us where character i is drawn.
- Ctrl/Cmd+Z is intercepted, because the browser's own undo history can't see remote edits.

**Files:**
- Create: `client/src/live/wsTransport.ts`, `client/src/live/useLiveNote.ts`,
  `client/src/components/LiveTextarea.tsx`, `client/src/components/RemoteCursors.tsx`
- Modify: `client/src/pages/NotePage.tsx`, `client/vite.config.ts`, `client/src/notes/api.ts`,
  `client/src/notes/api.test.ts`, `LEARNING.md`
- Delete: `client/src/notes/noteSync.ts`, `client/src/notes/noteSync.test.ts`,
  `client/src/notes/useNote.ts`

**Interfaces:**
- Consumes: `LiveNote`, `LiveSnapshot`, `Connect` (Task 10/11), `createOutbox`,
  `createPendingStore`, `createNotesApi`, `deriveNoteKeysInWorker` (Task 1).
- Produces:
  ```ts
  export function webSocketConnect(): Connect;   // wss: on https, ws: otherwise; `${host}/api/notes/${id}/live`; JSON frames
  export function useLiveNote(name: string): LiveSnapshot & Pick<LiveNote, "change" | "select" | "undo" | "redo" | "setComposing">;
  export function LiveTextarea(props: {
    text: string; selection: { start: number; end: number };
    onChange(next: string, start: number, end: number): void; onSelect(start: number, end: number): void;
    onUndo(): void; onRedo(): void; onComposing(on: boolean): void;
    cursors: RemoteCursor[]; placeholder: string;
  }): JSX.Element;
  ```
- **Rules:**
  - **`useLiveNote`:** mirror Phase 1 `useNote`: one engine per name (`useMemo`), start/dispose in
    an effect, `online` → `retryNow`, and `beforeunload` warns while `hasUnsentWork()`.
  - **`LiveTextarea`:**
    - It is a controlled `<textarea>`.
    - `onChange` passes the new value with `selectionStart`/`selectionEnd`.
    - `onSelect`/`keyup`/`mouseup` report the selection.
    - A `useLayoutEffect` applies `selection` when it differs from the DOM, and only while
      focused.
    - On keydown:
      - Ctrl/Cmd+Z → `preventDefault` + `onUndo`.
      - Ctrl/Cmd+Shift+Z or Ctrl+Y → `preventDefault` + `onRedo`.
      - Also handle `beforeinput` with `inputType` `historyUndo`/`historyRedo`.
    - `compositionstart`/`compositionend` → `onComposing`.
  - **`RemoteCursors`:**
    - An overlay positioned over the textarea, using the mirror-element technique.
    - It draws a 2 px caret and a translucent selection per cursor in its colour.
    - It follows textarea scroll and resize. Movement is eased with a CSS transition of ≤ 80 ms.
  - **Status line** (replaces `describeSave`), in this order of precedence:
    1. `"note is full"` when `full`;
    2. `"note is busy"` for busy;
    3. `"offline — will sync"` (with unsent count) for offline;
    4. `"connecting…"`;
    5. otherwise `"live · N here"`.
  - **Remove:**
    - `NoteSync`, `useNote`, `putNote`, `SaveResult`, `ConflictError`, `TooLargeError`,
      `MAX_BODY_BYTES`, and their tests.
    - Keep `getNote`, `NetworkError`, `HttpError`, `isRetryable` only if still used. Otherwise
      remove them too; `tsc` with `noUnusedLocals` is the judge.
  - **`vite.config.ts`:** proxy `"/api": { target: "http://localhost:8080", ws: true }`.

- [ ] **Step 1: Static checks first.** Write the components and the hook, delete the old files,
  then run `cd client && npx vitest run && npx tsc -b && npm run lint`. Expected: all pass. There
  are no new unit tests here: the DOM behaviour is verified manually in Step 2, and every rule
  above it is already covered by the engine tests.

- [ ] **Step 2: Manual two-tab check in dev.** Start `cd server && go run ./cmd/server` and
  `cd client && npm run dev`, open the same `/#/<name>` in two windows side by side, and report
  each result in chat:
  1. Typing in one appears in the other almost instantly. Your own typing has no perceptible lag.
  2. The other window's caret and selection show in colour and move smoothly. The status shows
     "live · 2 here", and closing one window changes it to 1.
  3. Typing above the other window's caret doesn't move its caret off its word.
  4. Ctrl+Z in window A undoes only A's text while B keeps typing. Ctrl+Shift+Z redoes.
  5. Stop the Go server and type in both windows: "offline — will sync". Restart it: both merge,
     and nothing is lost.
  6. Paste a large block (~200 KB): no freeze, and it arrives in the other window.

- [ ] **Step 3: LEARNING.md.** Add "React: driving the DOM selection with useLayoutEffect",
  "Mirror-element caret measurement", and "Intercepting undo".

- [ ] **Step 4: Commit:** `feat(client): live editor with remote cursors; remove Phase 1 save engine`

---

### Task 14: Final verification, docs, Docker

**Concept:** Each step below is a success criterion from spec §8; the executor checks them in
order. Before calling the phase done, verify each claim with evidence: tests, a real Docker run,
two real browsers, and a database grep.

**Files:**
- Modify: `README.md` (the "Security model, honestly" section gains: "the server sees when
  someone is typing (timing of edit batches) and how many people are in a note"; collaboration
  usage), `DEPLOY.md` (no changes needed unless WebSocket proxying fails; Caddy proxies WebSockets
  by default), `LEARNING.md`

- [ ] **Step 1: Run the full suites.**
  `cd server && go vet ./... && go test -count=1 ./... && go test -count=5 ./internal/live/` and
  `cd client && npx vitest run && npx tsc -b && npm run lint`. Expected: all pass.

- [ ] **Step 2: Docker end-to-end.**
  1. Run `DOMAIN=localhost docker compose up -d --build`.
  2. Open `https://localhost/#/<name>` in two browser windows (accept the local CA warning) and
     repeat the Task 13 checks 1, 2 and 5. For check 5, run `docker compose restart app`; that is
     the "server restart mid-session" case.
  3. Run `docker compose down`.

- [ ] **Step 3: Privacy grep.** While the stack is up, after typing a distinctive phrase:
  ```bash
  docker compose exec app sh -c 'cat /data/notes.db* | grep -a -c "<phrase>"'   # expect 0
  docker compose exec app sh -c 'cat /data/notes.db* | grep -a -c "<name>"'     # expect 0
  docker compose logs app | grep -c "<name>"                                    # expect 0
  ```
  As a control, also grep for the 43-char note id (expect ≥ 1) to prove the grep reads the files.

- [ ] **Step 4: Docs.** Update the README security section and add a short "Collaborating" note
  (share the `/#/` link; everyone with it can edit; the count shows who's here).

- [ ] **Step 5: Commit:** `docs: phase 2 security notes and collaboration usage`

- [ ] **Step 6: Stop.** Do not merge to `master`. The owner does the single cutover (spec §5).
