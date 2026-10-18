import { describe, expect, it } from "vitest";
import { Rga, opsFromState, type IdRange, type Op } from "./rga";

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
  it.each([
    [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0],
    [9, 3000], [10, 3000], [11, 3000], [12, 3000], // big shared start: edits cross internal chunk boundaries
  ])("random concurrent sessions converge (seed %i, prefill %i)", (seed, prefill) => {
    const rand = mulberry32(seed);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const replicas = ["1111111111111111", "2222222222222222", "3333333333333333"].map((r) => new Rga(r));
    const inbox: { to: number; op: Op }[] = [];
    if (prefill > 0) {
      const base = replicas[0].insert(0, "p".repeat(prefill));
      replicas[1].apply(base);
      replicas[2].apply(base);
    }
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

describe("Rga state", () => {
  it("round-trips text, tombstones and future convergence", () => {
    const a = new Rga("a".repeat(16));
    const b = new Rga("b".repeat(16));
    const o1 = a.insert(0, "hello world");
    b.apply(o1);
    a.delete(0, 6);
    const restored = Rga.fromState("c".repeat(16), a.toState());
    expect(restored.text()).toBe("world");
    const late = b.insert(5, "!"); // anchored on the 'o' of "hello", which a deleted (a tombstone)
    restored.apply(late);
    a.apply(late);
    expect(restored.text()).toBe(a.text());
  });

  it("new local ops after fromState get counters above everything in the state", () => {
    const a = new Rga("a".repeat(16));
    a.insert(0, "abc");
    const r = Rga.fromState("c".repeat(16), a.toState());
    const op = r.insert(3, "d");
    expect(op.k === "ins" && op.id.c).toBeGreaterThan(3);
  });

  it("is compact: a 1 MiB single-run note serialises under 1.2 MiB", () => {
    const a = new Rga("a".repeat(16));
    a.insert(0, "x".repeat(1 << 20));
    expect(JSON.stringify(a.toState()).length).toBeLessThan(1.2 * (1 << 20));
  });

  it("heavy history fits the snapshot frame: 1 MiB visible + 1 MiB tombstones < 8 MiB as base64-sealed", () => {
    const a = new Rga("a".repeat(16));
    const b = new Rga("b".repeat(16));
    const run = "y".repeat(1 << 10); // 2,000 runs of 1 KiB = 2 MiB
    for (let i = 0; i < 2000; i++) {
      const who = i % 2 === 0 ? a : b;
      const other = who === a ? b : a;
      other.apply(who.insert(who.length, run));
    }
    for (let i = 1999; i >= 0; i -= 2) a.delete(i * run.length, run.length);
    expect(a.length).toBe(1000 * run.length);
    const sealedSize = (JSON.stringify(a.toState()).length * 4) / 3 + 1024;
    expect(sealedSize).toBeLessThan(8 << 20);
  });

  it("stays fast: 2,000 single-char inserts at random spots in a 100 KB note < 300 ms", () => {
    const a = new Rga("a".repeat(16));
    a.insert(0, "z".repeat(100_000));
    const rand = mulberry32(42);
    const start = performance.now();
    for (let i = 0; i < 2000; i++) a.insert(Math.floor(rand() * (a.length + 1)), "k");
    const elapsed = performance.now() - start;
    expect(a.length).toBe(102_000);
    expect(elapsed).toBeLessThan(300);
  });
});

/** Random 3-replica session; returns every op in creation order (a causally-closed log at every prefix). */
function randomSession(seed: number, prefill: number): { log: Op[]; full: Rga } {
  const rand = mulberry32(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const replicas = ["1111111111111111", "2222222222222222", "3333333333333333"].map((r) => new Rga(r));
  const log: Op[] = [];
  const inbox: { to: number; op: Op }[] = [];
  if (prefill > 0) {
    const base = replicas[0].insert(0, "p".repeat(prefill));
    log.push(base);
    replicas[1].apply(base);
    replicas[2].apply(base);
  }
  const ownDeletes: IdRange[][][] = [[], [], []];
  for (let step = 0; step < 200; step++) {
    if (inbox.length > 0 && rand() < 0.5) {
      const { to, op } = inbox.splice(Math.floor(rand() * inbox.length), 1)[0];
      replicas[to].apply(op);
      continue;
    }
    const who = Math.floor(rand() * 3);
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
    log.push(op);
    for (let to = 0; to < 3; to++) if (to !== who) inbox.push({ to, op });
  }
  for (const { to, op } of inbox) replicas[to].apply(op);
  return { log, full: replicas[0] };
}

describe("opsFromState", () => {
  it("rebuilds a fresh replica", () => {
    for (const [seed, prefill] of [[1, 0], [2, 0], [3, 3000]]) {
      const { full } = randomSession(seed, prefill);
      const fresh = new Rga("9999999999999999");
      for (const op of opsFromState(full.toState())) fresh.apply(op);
      expect(fresh.text()).toBe(full.text());
      expect(fresh.toState()).toEqual(full.toState());
      expect(fresh.pendingCount()).toBe(0);
    }
  });

  it("completes any prefix replica (property)", () => {
    for (let seed = 1; seed <= 240; seed++) {
      const prefill = seed % 6 === 0 ? 3000 : 0; // some seeds cross chunk boundaries
      const { log, full } = randomSession(seed, prefill);
      const rand = mulberry32(seed * 7919);
      const k = Math.floor(rand() * (log.length + 1));
      const r = new Rga("8888888888888888");
      for (const op of log.slice(0, k)) r.apply(op);
      for (const op of opsFromState(full.toState())) r.apply(op);
      expect(r.text(), `seed ${seed} k ${k}`).toBe(full.text());
      expect(r.toState(), `seed ${seed} k ${k}`).toEqual(full.toState());
      expect(r.pendingCount()).toBe(0);
    }
  });

  it("a merged run completes a replica that holds only part of it", () => {
    const a = new Rga("a".repeat(16));
    const o1 = a.insert(0, "ab");
    const o2 = a.insert(2, "cd"); // ids continue: one run "abcd" in the state
    const r = new Rga("b".repeat(16));
    r.apply(o1);
    expect(a.toState().runs).toHaveLength(1);
    for (const op of opsFromState(a.toState())) r.apply(op);
    expect(r.text()).toBe("abcd");
    expect(o2.k).toBe("ins");
  });

  it("is a no-op on the same replica", () => {
    const { full } = randomSession(5, 0);
    const before = full.toState();
    const text = full.text();
    for (const op of opsFromState(before)) expect(full.apply(op)).toBe(false);
    expect(full.text()).toBe(text);
    expect(full.toState()).toEqual(before);
  });
});
