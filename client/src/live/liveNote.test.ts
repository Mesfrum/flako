import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptNote } from "../crypto/cipher";
import { fromBase64 } from "../crypto/encoding";
import type { RemoteNote } from "../notes/api";
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
    await until(() => hub.log.length === 1, "B's edit stored");
    for (let i = 0; i < 300; i++) await tick(); // plenty of time for it to reach A…
    expect(a.getSnapshot().text).toBe(""); // …where it is held while composing
    a.setComposing(false);
    await until(() => a.getSnapshot().text === "remote", "applied when composition ends");
  });
});

describe("LiveNote: Phase 1 notes and large edits", () => {
  const legacy = async (text: string): Promise<RemoteNote> => ({
    ...(await encryptNote(key, ID, text)),
    version: 1,
    updatedAt: 1,
  });

  it("opening a Phase 1 note imports it once even with two simultaneous openers", async () => {
    const hub = new FakeHub();
    const blob = await legacy("legacy text");
    const getNote = async () => blob;
    const a = engine(hub, memoryStorage(), { api: { getNote } });
    const b = engine(hub, memoryStorage(), { api: { getNote } });
    void a.start();
    void b.start();
    await until(() => a.getSnapshot().status.kind === "ready" && b.getSnapshot().status.kind === "ready", "both ready");
    await advance(200);
    await until(() => hub.log.length >= 1, "import sent");
    await until(() => a.getSnapshot().unsent === 0 && b.getSnapshot().unsent === 0, "both imports acked");
    expect(a.getSnapshot().text).toBe("legacy text");
    expect(b.getSnapshot().text).toBe("legacy text");
    const c = engine(hub); // a newcomer replays whatever both importers sent
    await ready(c);
    expect(c.getSnapshot().text).toBe("legacy text");
  });

  it("unsent Phase 1 text in pending:<id> is merged and the entry removed", async () => {
    const hub = new FakeHub();
    const storage = memoryStorage();
    const pending = createPendingStore(storage);
    pending.save(ID, { encrypted: await encryptNote(key, ID, "legacy text plus mine"), baseVersion: 1 });
    const blob = await legacy("legacy text");
    const a = engine(hub, storage, { api: { getNote: async () => blob } });
    await ready(a);
    await until(() => a.getSnapshot().text === "legacy text plus mine", "merged");
    expect(pending.load(ID)).toBeNull();
    await advance(200);
    await until(() => a.getSnapshot().unsent === 0, "A's import and merge acked by the hub");
    const b = engine(hub);
    await ready(b);
    expect(b.getSnapshot().text).toBe("legacy text plus mine");
  });

  it("an unreadable legacy blob makes the note unreadable", async () => {
    const hub = new FakeHub();
    const garbage: RemoteNote = { ciphertext: new Uint8Array(40), iv: new Uint8Array(12), version: 1, updatedAt: 1 };
    const a = engine(hub, memoryStorage(), { api: { getNote: async () => garbage } });
    void a.start();
    await until(() => a.getSnapshot().status.kind === "unreadable", "unreadable");
  });

  it("a large paste is split into frames under the server limit", async () => {
    const hub = new FakeHub();
    const storage = memoryStorage();
    const a = engine(hub, storage);
    const b = engine(hub);
    await ready(a);
    await ready(b);
    hub.online = false;
    hub.dropAll(); // keep the batches in the outbox so we can inspect them
    await until(() => a.getSnapshot().conn === "offline", "offline");
    const paste = "p".repeat(300_000) + "🌮".repeat(50_000);
    type(a, paste);
    await advance(50);
    await until(() => a.getSnapshot().unsent >= 2 && createOutbox(storage).list(ID).length >= 2, "split into batches");
    for (const item of createOutbox(storage).list(ID)) {
      expect(fromBase64(item.ct).length).toBeLessThanOrEqual(256 << 10);
    }
    hub.online = true;
    a.retryNow();
    b.retryNow();
    await until(() => b.getSnapshot().text === paste, "friend has the whole paste");
  });
});

describe("LiveNote: repairing after the server lost history", () => {
  /** Types `next` and waits until the hub has stored it and this tab has the ack. */
  async function typeAcked(note: LiveNote, hub: FakeHub, next: string) {
    const before = hub.log.length;
    type(note, next);
    await advance(50);
    await until(() => hub.log.length > before && note.getSnapshot().unsent === 0, `"${next}" stored and acked`);
  }

  const sorted = (s: string) => [...s].sort().join("");

  it("rewound server: tab ahead re-sends lost edits", async () => {
    const hub = new FakeHub();
    const a = engine(hub);
    await ready(a);
    await typeAcked(a, hub, "hello");
    const seen = new Set<string>();
    a.subscribe(() => seen.add(a.getSnapshot().text));
    hub.rewind(0);
    expect(hub.log).toHaveLength(0);
    await advance(1100);
    await until(() => hub.log.length >= 1 && a.getSnapshot().conn === "live", "A repaired the server");
    const hello = hub.helloMsgs[hub.helloMsgs.length - 1];
    expect(hello.have).toBeGreaterThan(0);
    expect(hello.haveIv).toBeTruthy();
    expect(hub.welcomes[hub.welcomes.length - 1].reset).toBe(true);
    expect(a.getSnapshot().text).toBe("hello");
    expect([...seen]).toEqual(["hello"]); // the text never changed, not even for a moment

    const c = engine(hub);
    await ready(c);
    await until(() => c.getSnapshot().text === "hello", "a newcomer sees the repaired note");
  });

  it("rewound then advanced: no skipped ops", async () => {
    const hub = new FakeHub();
    const a = engine(hub);
    await ready(a);
    for (const t of ["A", "AB", "ABC", "ABCD"]) await typeAcked(a, hub, t);
    expect(hub.log).toHaveLength(4);
    hub.rewind(2);
    const b = engine(hub);
    await ready(b); // catches up on A's first two ops
    await until(() => b.getSnapshot().text === "AB", "B has the surviving prefix");
    for (const t of ["AB1", "AB12", "AB123"]) await typeAcked(b, hub, t);
    expect(hub.log).toHaveLength(5); // seqs 3-5 are different ops reusing numbers A has already seen
    await advance(1100);
    await until(
      () => a.getSnapshot().conn === "live" && sorted(a.getSnapshot().text) === "123ABCD",
      "A has B's edits and its own",
    );
    const c = engine(hub);
    await ready(c);
    await until(() => sorted(c.getSnapshot().text) === "123ABCD", "newcomer has everything");
    await until(
      () => a.getSnapshot().text === b.getSnapshot().text && b.getSnapshot().text === c.getSnapshot().text,
      "A, B and C converge",
    );
  });

  it("healthy reconnect sends haveIv and gets no reset", async () => {
    const hub = new FakeHub();
    const a = engine(hub);
    await ready(a);
    await typeAcked(a, hub, "steady");
    const n = hub.log.length;
    hub.dropAll();
    await advance(1100);
    await until(() => hub.welcomes.length === 2 && a.getSnapshot().conn === "live", "reconnected");
    expect(hub.helloMsgs[1].have).toBe(n);
    expect(hub.helloMsgs[1].haveIv).toBeTruthy();
    expect(hub.welcomes[1].reset).toBe(false);
    await advance(300);
    expect(hub.log).toHaveLength(n);
    expect(a.getSnapshot().text).toBe("steady");
  });

  it("two tabs repairing at once converge", async () => {
    const hub = new FakeHub();
    const a = engine(hub);
    const b = engine(hub);
    await ready(a);
    await ready(b);
    await typeAcked(a, hub, "alpha");
    await until(() => b.getSnapshot().text === "alpha", "B has alpha");
    await typeAcked(b, hub, "alpha beta");
    await until(() => a.getSnapshot().text === "alpha beta", "A has beta");
    const original = hub.log.length;
    hub.rewind(0);
    await advance(1100);
    await until(() => hub.log.length >= 1 && a.getSnapshot().conn === "live" && b.getSnapshot().conn === "live", "both repaired");
    const c = engine(hub);
    await ready(c);
    await until(() => c.getSnapshot().text === "alpha beta", "newcomer converges");
    await advance(300);
    expect(a.getSnapshot().text).toBe("alpha beta");
    expect(b.getSnapshot().text).toBe("alpha beta");
    expect(hub.log.length).toBeLessThanOrEqual(2 * original);
  });

  it("a tab resetting after another already repaired the note sends nothing", async () => {
    const hub = new FakeHub();
    const a = engine(hub);
    const b = engine(hub);
    await ready(a);
    await ready(b);
    await typeAcked(a, hub, "alpha");
    await until(() => b.getSnapshot().text === "alpha", "B has alpha");
    await typeAcked(a, hub, "alp"); // a delete, so the filter's del/undel rule is exercised too
    await until(() => b.getSnapshot().text === "alp", "B has the delete");
    hub.online = false;
    hub.rewind(0);
    await until(() => a.getSnapshot().conn === "offline" && b.getSnapshot().conn === "offline", "both offline");
    hub.online = true;
    a.retryNow();
    await until(() => hub.log.length >= 1 && a.getSnapshot().conn === "live", "A repaired the server");
    const repaired = hub.log.length;
    b.retryNow();
    await until(() => hub.welcomes.length === 4 && b.getSnapshot().conn === "live", "B reconnected");
    expect(hub.welcomes[3].reset).toBe(true);
    await advance(300);
    expect(hub.log).toHaveLength(repaired); // B's text is all on the server already
    expect(b.getSnapshot().text).toBe("alp");
  });

  it("unsent outbox edits appear exactly once after a repair", async () => {
    const hub = new FakeHub();
    const a = engine(hub);
    await ready(a);
    await typeAcked(a, hub, "base");
    hub.holdAcks = true;
    type(a, "base+more");
    await advance(50);
    await until(() => hub.log.length === 2 && a.getSnapshot().unsent === 1, "second edit stored but unacked");
    hub.rewind(0);
    hub.holdAcks = false;
    await advance(1100);
    await until(() => a.getSnapshot().conn === "live" && a.getSnapshot().unsent === 0, "repaired and acked");
    expect(a.getSnapshot().text).toBe("base+more");
    const c = engine(hub);
    await ready(c);
    await until(() => c.getSnapshot().text === "base+more", "newcomer sees each edit once");
  });

  it("a reset arriving mid-composition changes nothing until it ends", async () => {
    const hub = new FakeHub();
    const a = engine(hub);
    await ready(a);
    await typeAcked(a, hub, "base");
    hub.rewind(0);
    a.setComposing(true);
    const b = engine(hub);
    await ready(b);
    await typeAcked(b, hub, "XYZ"); // the new log already holds text A has never seen
    await advance(1100);
    await until(() => a.getSnapshot().conn === "live", "A reconnected and repaired");
    await until(() => b.getSnapshot().text.includes("base"), "B received A's repair");
    expect(a.getSnapshot().text).toBe("base");
    a.setComposing(false);
    await until(() => a.getSnapshot().text === b.getSnapshot().text, "converged after composition");
    expect(sorted(a.getSnapshot().text)).toBe(sorted("baseXYZ"));
  });

  /** Lets the engine handle everything the hub sent (it withholds `synced`), then cuts the connection. */
  async function interruptCatchUp(hub: FakeHub) {
    await advance(100);
    hub.withholdSynced = false;
    hub.dropAll();
  }

  /** A types "A".."ABCD" with snapshots after every edit; waits until the hub holds snapshots at 2 and 4. */
  async function snapshottedABCD(hub: FakeHub) {
    const a = engine(hub, memoryStorage(), { snapshotEvery: 1 });
    await ready(a);
    await typeAcked(a, hub, "A");
    await typeAcked(a, hub, "AB");
    await until(() => hub.snapshots.some((x) => x.upTo === 2), "snapshot at 2");
    await typeAcked(a, hub, "ABC");
    await typeAcked(a, hub, "ABCD");
    await until(() => hub.snapshots.some((x) => x.upTo === 4), "snapshot at 4");
    return a;
  }

  it("P1: a connection cut after the reset welcome still repairs the server", async () => {
    const hub = new FakeHub();
    const a = engine(hub);
    await ready(a);
    await typeAcked(a, hub, "hello");
    hub.withholdSynced = true;
    hub.rewind(0);
    await advance(1100); // reconnect; reset welcome arrives, synced does not
    await until(() => hub.welcomes.length === 2, "reset welcome sent");
    await interruptCatchUp(hub);
    await advance(2100);
    await until(() => hub.log.length >= 1 && a.getSnapshot().conn === "live", "repaired after the second connect");
    expect(hub.welcomes.slice(-2).map((w) => w.reset)).toEqual([true, false]); // the cut really happened
    expect(a.getSnapshot().text).toBe("hello");
    const c = engine(hub);
    await ready(c);
    await until(() => c.getSnapshot().text === "hello", "newcomer sees the repaired note");
  });

  it("P2: text that came from a welcome snapshot survives a reset with an older snapshot", async () => {
    const hub = new FakeHub();
    const a = await snapshottedABCD(hub);
    const b = engine(hub);
    await ready(b);
    await until(() => b.getSnapshot().text === "ABCD", "B loaded the snapshot");
    a.dispose();
    const seen = new Set<string>();
    b.subscribe(() => seen.add(b.getSnapshot().text));
    hub.rewind(2); // leaves the snapshot at 2 ("AB") and two ops
    await advance(1100);
    await until(() => hub.log.length > 2 && b.getSnapshot().conn === "live", "B repaired the server");
    expect(b.getSnapshot().text).toBe("ABCD");
    expect([...seen]).not.toContain("AB");
    const c = engine(hub);
    await ready(c);
    await until(() => c.getSnapshot().text === "ABCD", "newcomer converges");
  });

  it("P3: same, with the connection cut after the reset welcome", async () => {
    const hub = new FakeHub();
    const a = await snapshottedABCD(hub);
    const b = engine(hub);
    await ready(b);
    await until(() => b.getSnapshot().text === "ABCD", "B loaded the snapshot");
    a.dispose();
    const seen = new Set<string>();
    b.subscribe(() => seen.add(b.getSnapshot().text));
    hub.withholdSynced = true;
    const welcomes = hub.welcomes.length;
    hub.rewind(2);
    await advance(1100);
    await until(() => hub.welcomes.length === welcomes + 1, "reset welcome sent");
    await interruptCatchUp(hub);
    await advance(2100);
    await until(() => hub.log.length > 2 && b.getSnapshot().conn === "live", "B repaired the server");
    expect(hub.welcomes.slice(-2).map((w) => w.reset)).toEqual([true, false]); // the cut really happened
    expect(b.getSnapshot().text).toBe("ABCD");
    expect([...seen]).not.toContain("AB");
    const c = engine(hub);
    await ready(c);
    await until(() => c.getSnapshot().text === "ABCD", "newcomer converges");
  });

  it("RG: a snapshot loaded before synced is never swapped for an older one after a rewind", async () => {
    const hub = new FakeHub();
    const a = await snapshottedABCD(hub);
    hub.withholdSynced = true;
    const b = engine(hub);
    void b.start();
    await until(() => b.getSnapshot().text === "ABCD", "B loaded the ABCD snapshot but is not synced");
    expect(b.getSnapshot().conn).not.toBe("live");
    hub.withholdSynced = false;
    a.dispose();
    const seen = new Set<string>();
    b.subscribe(() => seen.add(b.getSnapshot().text));
    const welcomes = hub.welcomes.length;
    hub.rewind(2); // B never reached synced, so it reconnects with have 0 and gets the older snapshot
    await advance(1100);
    await until(() => hub.welcomes.length === welcomes + 1 && b.getSnapshot().conn === "live", "B reconnected");
    expect(hub.welcomes[welcomes].reset).toBe(false);
    expect(b.getSnapshot().text).toBe("ABCD");
    expect([...seen]).not.toContain("AB");
  });

  it("a ~900 KiB note is repaired in frames under the limit", async () => {
    const hub = new FakeHub();
    const a = engine(hub);
    await ready(a);
    const big = "x".repeat(900 << 10);
    type(a, big);
    await advance(50);
    await until(() => a.getSnapshot().unsent === 0 && hub.log.length >= 4, "big note stored");
    const original = hub.log.length;
    hub.rewind(0);
    await advance(1100);
    await until(() => hub.log.length >= original && a.getSnapshot().unsent === 0, "repair frames stored");
    for (const entry of hub.log) expect(fromBase64(entry.ct).length).toBeLessThanOrEqual(256 << 10);
    expect(a.getSnapshot().full).toBe(false);
    const c = engine(hub);
    await ready(c);
    await until(() => c.getSnapshot().text.length === big.length, "newcomer converges");
  }, 30_000);
});
