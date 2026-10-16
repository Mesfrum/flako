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

  it("clear with an iv only removes the entry with that iv", () => {
    const store = createPendingStore(memoryStorage());
    store.save(ID, save);
    store.clear(ID, new Uint8Array(12).fill(1)); // someone else's entry: keep it
    expect(store.load(ID)).toEqual(save);
    store.clear(ID, save.encrypted.iv);
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
