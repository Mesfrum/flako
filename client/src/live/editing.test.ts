import { describe, expect, it } from "vitest";
import { Rga } from "./crdt/rga";
import { fromAnchor, spliceFromChange, toAnchor, type Splice } from "./editing";

describe("spliceFromChange", () => {
  it.each<[string, string, number, Splice]>([
    ["", "a", 1, { index: 0, remove: 0, insert: "a" }],
    ["aa", "aaa", 1, { index: 0, remove: 0, insert: "a" }], // caret disambiguates
    ["aa", "aaa", 3, { index: 2, remove: 0, insert: "a" }],
    ["hello", "hllo", 1, { index: 1, remove: 1, insert: "" }],
    ["teh cat", "the cat", 3, { index: 1, remove: 2, insert: "he" }], // autocorrect word replacement
    ["abc", "aXYc", 3, { index: 1, remove: 1, insert: "XY" }], // paste over selection
    ["a🌮b", "ab", 1, { index: 1, remove: 2, insert: "" }], // whole emoji
    ["a🌮b", "a🌯b", 3, { index: 1, remove: 2, insert: "🌯" }], // shared high surrogate not split
  ])("%j -> %j (caret %i)", (prev, next, caret, want) => {
    expect(spliceFromChange(prev, next, caret)).toEqual(want);
  });

  it("no change → null", () => {
    expect(spliceFromChange("x", "x", 1)).toBeNull();
  });

  it("applying the splice to prev always yields next (random cases)", () => {
    const alphabet = ["a", "b", "🌮", "🌯", " "];
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const word = () => Array.from({ length: Math.floor(rand() * 6) }, () => alphabet[Math.floor(rand() * 5)]).join("");
    for (let i = 0; i < 500; i++) {
      const prev = word() + word();
      const cut = Array.from(prev).slice(0, Math.floor(rand() * (Array.from(prev).length + 1))).join("");
      const inserted = word();
      const rest = Array.from(prev.slice(cut.length)); // whole code points, like a real textarea edit
      const next = cut + inserted + rest.slice(Math.min(rest.length, Math.floor(rand() * 3))).join("");
      const s = spliceFromChange(prev, next, cut.length + inserted.length);
      const rebuilt = s ? prev.slice(0, s.index) + s.insert + prev.slice(s.index + s.remove) : prev;
      expect(rebuilt).toBe(next);
      if (s) {
        // never splits a surrogate pair
        for (const edge of [s.index, s.index + s.remove]) {
          const code = prev.charCodeAt(edge);
          expect(code >= 0xdc00 && code <= 0xdfff).toBe(false);
        }
      }
    }
  });
});

describe("anchors", () => {
  it("survive remote edits before, at and after them", () => {
    const me = new Rga("a".repeat(16));
    const them = new Rga("b".repeat(16));
    const base = me.insert(0, "hello world");
    them.apply(base);
    const a = toAnchor(me, 6); // just before "w"
    me.apply(them.insert(0, ">> "));
    expect(fromAnchor(me, a)).toBe(9);
    me.apply(them.delete(3 + 5, 1)!); // delete the space before "w"
    expect(fromAnchor(me, a)).toBe(8);
    expect(fromAnchor(me, toAnchor(me, 0))).toBe(0);
  });
});
