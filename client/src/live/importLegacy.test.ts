import { describe, expect, it } from "vitest";
import { IMPORT_REPLICA, Rga } from "./crdt/rga";
import { importOps, legacySpliceOps } from "./importLegacy";

describe("importOps", () => {
  it("is deterministic (same ops for the same text)", () => {
    expect(importOps("hello world", 4)).toEqual(importOps("hello world", 4));
    const ops = importOps("hello world", 4);
    expect(ops).toHaveLength(3);
    expect(ops[0]).toEqual({ k: "ins", id: { c: 1, r: IMPORT_REPLICA }, after: null, text: "hell" });
    expect(ops[1]).toEqual({ k: "ins", id: { c: 5, r: IMPORT_REPLICA }, after: { c: 4, r: IMPORT_REPLICA }, text: "o wo" });
  });

  it("two replicas importing concurrently converge to one copy", () => {
    const a = new Rga("a".repeat(16));
    const b = new Rga("b".repeat(16));
    const opsA = importOps("legacy text", 3);
    const opsB = importOps("legacy text", 3);
    for (const op of opsA) a.apply(op);
    for (const op of opsB) b.apply(op);
    for (const op of opsB) a.apply(op);
    for (const op of opsA) b.apply(op);
    expect(a.text()).toBe("legacy text");
    expect(b.text()).toBe("legacy text");
  });

  it("chunks never split a surrogate pair", () => {
    const ops = importOps("ab🌮cd", 3);
    for (const op of ops) {
      if (op.k !== "ins") throw new Error("not an insert");
      const last = op.text.charCodeAt(op.text.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    const r = new Rga("a".repeat(16));
    for (const op of ops) r.apply(op);
    expect(r.text()).toBe("ab🌮cd");
  });

  it("empty text imports nothing", () => {
    expect(importOps("")).toEqual([]);
  });
});

describe("legacySpliceOps", () => {
  it("applies unsent text on top of later edits", () => {
    const rga = new Rga("a".repeat(16));
    for (const op of importOps("hello world")) rga.apply(op);
    const friend = new Rga("f".repeat(16));
    for (const op of importOps("hello world")) friend.apply(op);
    rga.apply(friend.insert(6, "big ")); // friend edited after the import
    legacySpliceOps("hello world", "hello brave world", rga);
    const text = rga.text();
    expect(text.startsWith("hello ")).toBe(true);
    expect(text.split("brave").length - 1).toBe(1);
    expect(text.split("big").length - 1).toBe(1);
    expect(text.endsWith("world")).toBe(true);
  });

  it("deletions in the unsent text remove exactly those imported characters", () => {
    const rga = new Rga("a".repeat(16));
    for (const op of importOps("keep DROP keep")) rga.apply(op);
    legacySpliceOps("keep DROP keep", "keep keep", rga);
    expect(rga.text()).toBe("keep keep");
  });

  it("returns no ops when nothing changed", () => {
    const rga = new Rga("a".repeat(16));
    for (const op of importOps("same")) rga.apply(op);
    expect(legacySpliceOps("same", "same", rga)).toEqual([]);
  });
});
