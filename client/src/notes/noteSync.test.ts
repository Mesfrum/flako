import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptNote, encryptNote, type EncryptedNote } from "../crypto/cipher";
import { ConflictError, HttpError, NetworkError, TooLargeError, type NotesApi, type RemoteNote } from "./api";
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

// Node's real setImmediate (not faked, and absent from the DOM types this project compiles against).
const realSetImmediate = (globalThis as unknown as { setImmediate: (cb: () => void) => void }).setImmediate;

async function until(predicate: () => boolean, what: string) {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return;
    await new Promise<void>((r) => realSetImmediate(r));
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

describe("review fixes: nothing typed is lost", () => {
  const pendingText = async (pending: ReturnType<typeof createPendingStore>) => {
    const p = pending.load(ID);
    return p ? decryptNote(key, ID, p.encrypted) : null;
  };
  async function untilAsync(predicate: () => Promise<boolean>, what: string) {
    for (let i = 0; i < 2000; i++) {
      if (await predicate()) return;
      await new Promise<void>((r) => realSetImmediate(r));
    }
    throw new Error(`timed out waiting for ${what}`);
  }
  const reopen = (api: FakeApi, pending: ReturnType<typeof createPendingStore>) =>
    new NoteSync("any-name", { api, pending, derive: async () => ({ id: ID, key }), debounceMs: 1000 });

  it("dispose after recovering from offline clears pending, so reopening is clean (no false conflict)", async () => {
    const { api, pending, sync } = setup();
    await sync.start();
    api.failures.push(new NetworkError());
    sync.setText("old");
    vi.advanceTimersByTime(1000);
    await until(() => state(sync) === "ready:unsaved", "unsaved");
    sync.setText("old plus new");
    sync.dispose(); // server is back: the dispose flush succeeds
    await until(() => api.notes.get(ID)?.version === 1, "dispose flush saved");
    await until(() => pending.load(ID) === null, "pending cleared");

    const again = reopen(api, pending);
    await again.start();
    expect(again.getSnapshot().text).toBe("old plus new");
    expect(state(again)).toBe("ready:clean");
  });

  it("dispose while still offline keeps the latest text in pending", async () => {
    const { api, pending, sync } = setup();
    await sync.start();
    api.failures.push(new NetworkError(), new NetworkError());
    sync.setText("v1");
    vi.advanceTimersByTime(1000);
    await until(() => state(sync) === "ready:unsaved", "unsaved");
    sync.setText("v1 v2");
    sync.dispose();
    await until(() => api.putCalls === 2, "dispose flush attempted");
    await untilAsync(async () => (await pendingText(pending)) === "v1 v2", "pending holds v1 v2");
  });

  it("dispose during an in-flight save still sends the newer keystrokes", async () => {
    const { api, sync } = setup();
    await sync.start();
    let release!: () => void;
    api.gate = new Promise((r) => (release = r));
    sync.setText("first");
    vi.advanceTimersByTime(1000);
    await until(() => api.putCalls === 1, "first PUT");
    sync.setText("first second");
    sync.dispose();
    api.gate = null;
    release();
    await until(() => api.putCalls === 2 && api.notes.get(ID)?.version === 2, "follow-up after dispose");
    expect(await remoteText(api)).toBe("first second");
  });

  it("typing while offline keeps pending up to date between retries", async () => {
    const { api, pending, sync } = setup();
    await sync.start();
    api.failures.push(new NetworkError());
    sync.setText("draft");
    vi.advanceTimersByTime(1000);
    await until(() => state(sync) === "ready:unsaved", "unsaved");
    sync.setText("draft, much longer now");
    await untilAsync(async () => (await pendingText(pending)) === "draft, much longer now", "pending updated");
  });

  it("typing under the conflict banner keeps pending up to date", async () => {
    const { api, pending, sync } = setup();
    await seedRemote(api, "base", 1);
    await sync.start();
    await seedRemote(api, "theirs", 2);
    sync.setText("mine");
    vi.advanceTimersByTime(1000);
    await until(() => state(sync) === "ready:conflict", "conflict");
    sync.setText("mine, still typing");
    await untilAsync(async () => (await pendingText(pending)) === "mine, still typing", "pending updated");
    expect(pending.load(ID)!.baseVersion).toBe(1); // reload must still conflict, not overwrite
  });

  it("a non-retryable server error keeps the text in pending", async () => {
    const { api, pending, sync } = setup();
    await sync.start();
    api.failures.push(new HttpError(400));
    sync.setText("rejected words");
    vi.advanceTimersByTime(1000);
    await until(() => state(sync) === "error", "error");
    expect(await pendingText(pending)).toBe("rejected words");
  });

  it("reports unsaved work so the page can warn before closing", async () => {
    const { api, sync } = setup();
    await sync.start();
    expect(sync.hasUnsavedWork()).toBe(false);
    sync.setText("x");
    expect(sync.hasUnsavedWork()).toBe(true);
    vi.advanceTimersByTime(1000);
    await until(() => state(sync) === "ready:clean", "clean");
    expect(sync.hasUnsavedWork()).toBe(false);
    api.failures.push(new NetworkError());
    sync.setText("y");
    vi.advanceTimersByTime(1000);
    await until(() => state(sync) === "ready:unsaved", "unsaved");
    expect(sync.hasUnsavedWork()).toBe(true);
  });
});

describe("review fixes: conflicts stay put", () => {
  it("typing during a save that conflicts does not fire a second stale PUT", async () => {
    const { api, sync } = setup();
    await seedRemote(api, "base", 1);
    await sync.start();
    await seedRemote(api, "theirs", 2);
    let release!: () => void;
    api.gate = new Promise((r) => (release = r));
    sync.setText("mine");
    vi.advanceTimersByTime(1000);
    await until(() => api.putCalls === 1, "first PUT");
    sync.setText("mine more"); // arms the debounce while the doomed save is in flight
    api.gate = null;
    release();
    await until(() => state(sync) === "ready:conflict", "conflict");
    vi.advanceTimersByTime(5000);
    for (let i = 0; i < 50; i++) await new Promise<void>((r) => realSetImmediate(r)); // let any stray PUT start
    expect(api.putCalls).toBe(1);
  });
});
