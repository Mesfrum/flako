import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPendingStore, memoryStorage, type KeyValueStorage } from "../notes/pending";
import { LiveNote, type LiveNoteDeps } from "./liveNote";
import { createOutbox } from "./outbox";
import { FakeHub } from "./testing/fakeHub";

const ID = "a".repeat(43);
let key: CryptoKey;

beforeAll(async () => {
  key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
});
// Fake only timers; microtasks and setImmediate stay real so WebCrypto and the fake hub can run.
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
afterEach(() => vi.useRealTimers());

// Node's real setImmediate (not faked, and absent from the DOM types this project compiles against).
const realSetImmediate = (globalThis as unknown as { setImmediate: (cb: () => void) => void }).setImmediate;
const tick = () => new Promise<void>((r) => realSetImmediate(r));

async function until(predicate: () => boolean, what: string) {
  for (let i = 0; i < 3000; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Advance fake time in small steps, letting async work (crypto, hub delivery) run in between. */
async function advance(ms: number, step = 50) {
  for (let t = 0; t < ms; t += step) {
    vi.advanceTimersByTime(Math.min(step, ms - t));
    for (let i = 0; i < 5; i++) await tick();
  }
}

function engine(hub: FakeHub, storage: KeyValueStorage = memoryStorage(), extra: Partial<LiveNoteDeps> = {}) {
  return new LiveNote("any-name", {
    connect: hub.connect,
    api: { getNote: async () => null },
    outbox: createOutbox(storage),
    legacyPending: createPendingStore(storage),
    derive: async () => ({ id: ID, key }),
    ...extra,
  });
}

async function ready(note: LiveNote) {
  void note.start();
  await until(() => note.getSnapshot().status.kind === "ready" && note.getSnapshot().conn === "live", "ready + live");
}

/** Types by replacing the whole text, with the caret at `caret` (default: end of next). */
function type(note: LiveNote, next: string, caret = next.length) {
  note.change(next, caret, caret);
}

describe("LiveNote sync core", () => {
  it("a new note opens empty and live", async () => {
    const hub = new FakeHub();
    const a = engine(hub);
    await ready(a);
    const s = a.getSnapshot();
    expect(s.text).toBe("");
    expect(s.here).toBe(1);
    expect(s.unsent).toBe(0);
  });

  it("typing appears for the friend after the batch interval", async () => {
    const hub = new FakeHub();
    const storageA = memoryStorage();
    const a = engine(hub, storageA);
    const b = engine(hub);
    await ready(a);
    await ready(b);
    type(a, "hi");
    expect(a.getSnapshot().text).toBe("hi"); // instantly, locally
    expect(b.getSnapshot().text).toBe("");
    await advance(50);
    await until(() => b.getSnapshot().text === "hi", "friend sees hi");
    await until(() => a.getSnapshot().unsent === 0, "ack clears the outbox");
    expect(createOutbox(storageA).list(ID)).toEqual([]);
  });

  it("both type at once in the same line and converge", async () => {
    const hub = new FakeHub();
    const a = engine(hub);
    const b = engine(hub);
    await ready(a);
    await ready(b);
    type(a, "hello world");
    await advance(50);
    await until(() => b.getSnapshot().text === "hello world", "base synced");
    type(a, "hello big world", 9); // A inserts "big " at 6
    type(b, "hello world!"); // B appends "!"
    await advance(50);
    await until(() => a.getSnapshot().text === b.getSnapshot().text, "converged");
    expect(a.getSnapshot().text).toBe("hello big world!");
  });

  it("a remote insert before my caret keeps my caret on the same character", async () => {
    const hub = new FakeHub();
    const a = engine(hub);
    const b = engine(hub);
    await ready(a);
    await ready(b);
    type(a, "hello world");
    await advance(50);
    await until(() => b.getSnapshot().text === "hello world", "synced");
    a.select(6, 6); // just before "w"
    type(b, ">> hello world", 3);
    await advance(50);
    await until(() => a.getSnapshot().text === ">> hello world", "remote insert arrives");
    expect(a.getSnapshot().selection).toEqual({ start: 9, end: 9 });
  });

  it("offline typing is kept in the outbox and merges on reconnect", async () => {
    const hub = new FakeHub();
    const storageA = memoryStorage();
    const a = engine(hub, storageA);
    const b = engine(hub);
    await ready(a);
    await ready(b);
    hub.online = false;
    hub.dropAll();
    await until(() => a.getSnapshot().conn === "offline", "A offline");
    type(a, "offline words");
    await advance(50);
    expect(a.getSnapshot().unsent).toBeGreaterThan(0);
    await until(() => createOutbox(storageA).list(ID).length === 1, "sealed into the outbox");
    const raw = storageA.getItem(`outbox:${ID}`) ?? "";
    expect(raw.length).toBeGreaterThan(0);
    expect(raw).not.toContain("offline");

    hub.online = true;
    await advance(4000); // backoff 1 s, 2 s …
    await until(() => b.getSnapshot().text === "offline words", "B receives the offline edit");
    await until(() => a.getSnapshot().unsent === 0, "outbox drained");
    expect(a.getSnapshot().conn).toBe("live");
  });

  it("server restart mid-session: reconnect with have, catch up, nothing lost", async () => {
    const hub = new FakeHub();
    const a = engine(hub);
    const b = engine(hub);
    await ready(a);
    await ready(b);
    type(a, "one ");
    await advance(50);
    await until(() => b.getSnapshot().text === "one ", "first edit shared");
    const haveBeforeDrop = hub.log.length;

    hub.online = false;
    hub.dropAll();
    await until(() => a.getSnapshot().conn === "offline" && b.getSnapshot().conn === "offline", "both offline");
    hub.online = true;
    b.retryNow();
    await until(() => b.getSnapshot().conn === "live", "B back first");
    type(b, "one two");
    await advance(50);
    await until(() => hub.log.length === haveBeforeDrop + 1, "B's edit stored");

    const hellosBefore = hub.hellos.length;
    await advance(3000); // A's backoff fires
    await until(() => a.getSnapshot().text === "one two", "A caught up");
    expect(hub.hellos.slice(hellosBefore)).toContain(haveBeforeDrop);
  });

  it("a dead socket is detected by the heartbeat", async () => {
    const hub = new FakeHub();
    const a = engine(hub);
    await ready(a);
    hub.silence();
    await advance(25_000 + 10_000, 1000);
    await until(() => a.getSnapshot().conn !== "live", "no longer claims live");
    hub.resume();
    await advance(5000, 250);
    await until(() => a.getSnapshot().conn === "live", "reconnected");
    expect(hub.peers()).toBe(1);
  });

  it("dispose with unbatched edits writes them to the outbox", async () => {
    const hub = new FakeHub();
    const storage = memoryStorage();
    const a = engine(hub, storage);
    await ready(a);
    hub.online = false;
    hub.dropAll();
    await until(() => a.getSnapshot().conn === "offline", "offline");
    type(a, "bye");
    a.dispose();
    await until(() => createOutbox(storage).list(ID).length === 1, "flushed on dispose");
  });

  it("two tabs sharing one outbox don't duplicate text", async () => {
    const hub = new FakeHub();
    const shared = memoryStorage();
    const a = engine(hub, shared);
    const b = engine(hub);
    await ready(a);
    await ready(b);
    hub.online = false;
    hub.dropAll();
    await until(() => a.getSnapshot().conn === "offline", "A offline");
    type(a, "from tab one");
    await advance(50);
    await until(() => createOutbox(shared).list(ID).length === 1, "in the shared outbox");
    a.dispose();

    hub.online = true;
    b.retryNow();
    const a2 = engine(hub, shared); // second tab, same browser storage
    await ready(a2);
    await until(() => b.getSnapshot().text === "from tab one", "B gets it");
    await until(() => a2.getSnapshot().text === "from tab one", "the new tab shows it too");
    await advance(500);
    expect(b.getSnapshot().text).toBe("from tab one");
  });

  it("an undecryptable op makes the note unreadable and refuses edits", async () => {
    const hub = new FakeHub();
    hub.log.push({ seq: 1, ct: btoa("x".repeat(40)), iv: btoa("y".repeat(12)) });
    const a = engine(hub);
    void a.start();
    await until(() => a.getSnapshot().status.kind === "unreadable", "unreadable");
    type(a, "overwrite attempt");
    await advance(200);
    expect(hub.log.length).toBe(1);
  });
});

describe("LiveNote presence, undo, limits, snapshots, IME", () => {
  it("my cursor appears for the friend and follows edits", async () => {
    const hub = new FakeHub();
    const a = engine(hub);
    const b = engine(hub);
    await ready(a);
    await ready(b);
    type(a, "hello world");
    await advance(50);
    await until(() => b.getSnapshot().text === "hello world", "synced");
    a.select(2, 4);
    await advance(50);
    await until(() => b.getSnapshot().cursors.some((c) => c.start === 2 && c.end === 4), "B sees A's selection");
    expect(b.getSnapshot().cursors).toHaveLength(1);
    expect(a.getSnapshot().cursors).toHaveLength(1); // only B's cursor: my own is never shown to me
    type(b, "X" + b.getSnapshot().text, 1); // B inserts before A's selection
    await until(() => {
      const c = b.getSnapshot().cursors[0];
      return c !== undefined && c.start === 3 && c.end === 5;
    }, "A's cursor shifted on B's screen");
  });

  it("a leaving friend's cursor disappears; here updates", async () => {
    const hub = new FakeHub();
    const a = engine(hub);
    const b = engine(hub);
    await ready(a);
    await ready(b);
    await until(() => a.getSnapshot().here === 2, "two here");
    b.select(0, 0);
    await advance(50);
    await until(() => a.getSnapshot().cursors.length === 1, "B's cursor shown");
    b.dispose();
    await until(() => a.getSnapshot().cursors.length === 0 && a.getSnapshot().here === 1, "B gone");
  });

  it("undo removes only my text while the friend types in the same line", async () => {
    const hub = new FakeHub();
    const a = engine(hub);
    const b = engine(hub);
    await ready(a);
    await ready(b);
    type(a, "mine ");
    await advance(50);
    await until(() => b.getSnapshot().text === "mine ", "mine shared");
    type(b, "mine theirs");
    await advance(50);
    await until(() => a.getSnapshot().text === "mine theirs", "theirs shared");
    a.undo();
    expect(a.getSnapshot().text).toBe("theirs");
    expect(a.getSnapshot().selection).toEqual({ start: 0, end: 0 });
    await advance(50);
    await until(() => b.getSnapshot().text === "theirs", "B sees the undo");
  });

  it("redo brings it back for everyone", async () => {
    const hub = new FakeHub();
    const a = engine(hub);
    const b = engine(hub);
    await ready(a);
    await ready(b);
    type(a, "again");
    await advance(50);
    a.undo();
    await advance(50);
    await until(() => b.getSnapshot().text === "", "undone everywhere");
    a.redo();
    expect(a.getSnapshot().text).toBe("again");
    await advance(50);
    await until(() => b.getSnapshot().text === "again", "redone everywhere");
  });

  it("a paste past the limit is refused and flagged full; deleting clears it", async () => {
    const hub = new FakeHub();
    const a = engine(hub, memoryStorage(), { maxTextBytes: 10 });
    await ready(a);
    type(a, "0123456789");
    expect(a.getSnapshot().text).toBe("0123456789");
    type(a, "0123456789X");
    expect(a.getSnapshot().text).toBe("0123456789");
    expect(a.getSnapshot().full).toBe(true);
    type(a, "012345678");
    expect(a.getSnapshot().text).toBe("012345678");
    expect(a.getSnapshot().full).toBe(false);
  });

  it("the limit counts UTF-8 bytes, not characters", async () => {
    const hub = new FakeHub();
    const a = engine(hub, memoryStorage(), { maxTextBytes: 10 });
    await ready(a);
    type(a, "🌮🌮🌮"); // 12 UTF-8 bytes, 6 UTF-16 units
    expect(a.getSnapshot().full).toBe(true);
    expect(a.getSnapshot().text).toBe("");
  });

  it("uploads a snapshot only from fully shared state", async () => {
    const hub = new FakeHub();
    const a = engine(hub, memoryStorage(), { snapshotEvery: 5, batchMs: 5000 }); // A's own edit lingers unsent
    const b = engine(hub);
    await ready(a);
    await ready(b);
    type(a, "mine");
    for (let i = 1; i <= 5; i++) {
      type(b, "y".repeat(i));
      await advance(50);
    }
    await until(() => hub.log.length === 5, "five of B's ops stored");
    await advance(500);
    // A has seen seqs 1..5 (threshold reached) but its own edit isn't shared yet: no snapshot.
    expect(hub.snapshots).toHaveLength(0);

    await advance(5000); // A's batch goes out and is acked as seq 6
    await until(() => hub.snapshots.length === 1, "snapshot once everything is shared");
    expect(hub.snapshots[0].upTo).toBe(6);
  });

  it("a snapshot made by one friend opens correctly for a newcomer", async () => {
    const hub = new FakeHub();
    const a = engine(hub, memoryStorage(), { snapshotEvery: 3 });
    await ready(a);
    for (const t of ["a", "ab", "abc", "abcd"]) {
      type(a, t);
      await advance(50);
    }
    await until(() => hub.snapshots.length >= 1 && hub.log.length === 4, "snapshot and all four ops stored");
    // At op 3 (or op 4, if the 4th edit was still unacked then): never from a state with unacked edits.
    expect(hub.snapshots[0].upTo).toBeGreaterThanOrEqual(3);
    const c = engine(hub);
    await ready(c);
    expect(c.getSnapshot().text).toBe("abcd");
  });

  it("remote edits wait while composing, then apply", async () => {
    const hub = new FakeHub();
    const a = engine(hub);
    const b = engine(hub);
    await ready(a);
    await ready(b);
    a.setComposing(true);
    type(b, "remote");
    await advance(50);
    await advance(200);
    expect(a.getSnapshot().text).toBe("");
    a.setComposing(false);
    expect(a.getSnapshot().text).toBe("remote");
  });
});
