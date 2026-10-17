import { describe, expect, it } from "vitest";
import { Rga, type IdRange, type Op } from "./rga";

/** Small seeded PRNG so a failing seed reproduces exactly. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
    const a = new Rga("aaaaaaaaaaaaaaaa");
    const b = new Rga("bbbbbbbbbbbbbbbb");
    const base = a.insert(0, "xy");
    b.apply(base);
    const oa = a.insert(1, "A");
    const ob = b.insert(1, "B");
    a.apply(ob);
    b.apply(oa);
    expect(a.text()).toBe(b.text());
    expect(a.text()).toBe("xBAy"); // equal counters; "bbbb…" > "aaaa…" goes first
  });

  it("applying an op twice is a no-op", () => {
    const a = new Rga("a".repeat(16));
    const b = new Rga("b".repeat(16));
    const op = a.insert(0, "hi");
    expect(b.apply(op)).toBe(true);
    expect(b.apply(op)).toBe(false);
    expect(b.text()).toBe("hi");
  });

  it("buffers an op whose anchor is unknown, then applies it when the anchor arrives", () => {
    const a = new Rga("a".repeat(16));
    const b = new Rga("b".repeat(16));
    const first = a.insert(0, "ab");
    const second = a.insert(2, "c");
    b.apply(second);
    expect(b.text()).toBe("");
    expect(b.pendingCount()).toBe(1);
    b.apply(first);
    expect(b.text()).toBe("abc");
    expect(b.pendingCount()).toBe(0);
  });

  it("delete vs undelete is last-writer-wins on the stamp", () => {
    const a = new Rga("a".repeat(16));
    const b = new Rga("b".repeat(16));
    const ins = a.insert(0, "x");
    b.apply(ins);
    const del = a.delete(0, 1)!;
    b.apply(del);
    const und = b.undeleteIds([{ r: "a".repeat(16), c: 1, n: 1 }]);
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
    const rand = mulberry32(seed);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const replicas = ["1111111111111111", "2222222222222222", "3333333333333333"].map((r) => new Rga(r));
    const inbox: { to: number; op: Op }[] = [];
    const ownDeletes: IdRange[][][] = [[], [], []]; // per replica: ranges of its own deletes (always known to it)

    const broadcast = (from: number, op: Op) => {
      for (let to = 0; to < replicas.length; to++) {
        if (to === from) continue;
        inbox.push({ to, op });
        if (rand() < 0.2) inbox.push({ to, op }); // duplicate delivery
      }
    };
    const deliverOne = () => {
      const i = Math.floor(rand() * inbox.length);
      const { to, op } = inbox.splice(i, 1)[0];
      replicas[to].apply(op);
    };

    for (let step = 0; step < 200; step++) {
      if (inbox.length > 0 && rand() < 0.5) {
        deliverOne();
        continue;
      }
      const who = Math.floor(rand() * replicas.length);
      const rga = replicas[who];
      const roll = rand();
      let op: Op | null;
      if (roll < 0.6 || rga.length === 0) {
        const len = 1 + Math.floor(rand() * 3);
        const text = Array.from({ length: len }, () => pick([..."abcdefgh "])).join("");
        op = rga.insert(Math.floor(rand() * (rga.length + 1)), text);
      } else if (roll < 0.9 || ownDeletes[who].length === 0) {
        const at = Math.floor(rand() * rga.length);
        op = rga.delete(at, 1 + Math.floor(rand() * Math.min(3, rga.length - at)));
      } else {
        op = rga.undeleteIds(pick(ownDeletes[who]));
      }
      if (!op) continue;
      if (op.k === "del") ownDeletes[who].push(op.ranges);
      broadcast(who, op);
    }
    while (inbox.length > 0) deliverOne();

    const [a, b, c] = replicas;
    expect(b.text()).toBe(a.text());
    expect(c.text()).toBe(a.text());
    for (const r of replicas) expect(r.pendingCount()).toBe(0);
  });
});
