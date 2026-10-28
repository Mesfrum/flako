import { describe, expect, it } from "vitest";
import type { NoteKeys } from "./derive";
import { createKeyCache } from "./keyCache";

// A derive whose calls finish only when the test says so.
function fakeDerive() {
  const calls: { name: string; resolve: () => void; reject: () => void }[] = [];
  const derive = (name: string) =>
    new Promise<NoteKeys>((resolve, reject) => {
      calls.push({
        name,
        resolve: () => resolve({ id: `id-${name}` } as NoteKeys),
        reject: () => reject(new Error("boom")),
      });
    });
  return { derive, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("key cache", () => {
  it("get after prefetch reuses the same derivation", async () => {
    const { derive, calls } = fakeDerive();
    const cache = createKeyCache(derive);
    cache.prefetch("taco");
    const keys = cache.get("taco");
    expect(calls.map((c) => c.name)).toEqual(["taco"]);
    calls[0].resolve();
    expect((await keys).id).toBe("id-taco");
  });

  it("get for another name derives that name", async () => {
    const { derive, calls } = fakeDerive();
    const cache = createKeyCache(derive);
    cache.prefetch("taco");
    calls[0].resolve();
    await tick();
    const keys = cache.get("burrito");
    expect(calls.map((c) => c.name)).toEqual(["taco", "burrito"]);
    calls[1].resolve();
    expect((await keys).id).toBe("id-burrito");
  });

  it("runs one prefetch at a time and skips names typed past", async () => {
    const { derive, calls } = fakeDerive();
    const cache = createKeyCache(derive);
    cache.prefetch("t");
    cache.prefetch("ta");
    cache.prefetch("tac");
    expect(calls.map((c) => c.name)).toEqual(["t"]);
    calls[0].resolve();
    await tick();
    expect(calls.map((c) => c.name)).toEqual(["t", "tac"]);
  });

  it("does not derive the same name twice", async () => {
    const { derive, calls } = fakeDerive();
    const cache = createKeyCache(derive);
    cache.prefetch("taco");
    calls[0].resolve();
    await tick();
    cache.prefetch("taco");
    void cache.get("taco");
    expect(calls).toHaveLength(1);
  });

  it("get cancels a queued prefetch it does not need", async () => {
    const { derive, calls } = fakeDerive();
    const cache = createKeyCache(derive);
    cache.prefetch("a");
    cache.prefetch("b"); // queued behind "a"
    void cache.get("c");
    calls[0].resolve();
    await tick();
    expect(calls.map((c) => c.name)).toEqual(["a", "c"]);
  });

  it("a failed prefetch is retried by get", async () => {
    const { derive, calls } = fakeDerive();
    const cache = createKeyCache(derive);
    cache.prefetch("taco");
    const keys = cache.get("taco");
    calls[0].reject();
    await tick();
    expect(calls.map((c) => c.name)).toEqual(["taco", "taco"]);
    calls[1].resolve();
    expect((await keys).id).toBe("id-taco");
  });
});
