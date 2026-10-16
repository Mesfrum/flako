import { describe, expect, it } from "vitest";
import { estimateStrength, generateName, normalizeName, randomIndex } from "./names";
import { WORDLIST } from "./wordlist";

describe("normalizeName", () => {
  it("trims and lowercases", () => {
    expect(normalizeName("  Taco ")).toBe("taco");
  });

  it("treats composed and decomposed accents as the same name", () => {
    expect(normalizeName("Café")).toBe(normalizeName("Café"));
  });

  it("keeps inner spaces and slashes (they are part of the name)", () => {
    expect(normalizeName(" My Notes/Work ")).toBe("my notes/work");
  });

  it("returns empty for blank input", () => {
    expect(normalizeName("   ")).toBe("");
  });
});

describe("randomIndex", () => {
  it("stays within [0, n)", () => {
    for (let i = 0; i < 1000; i++) {
      const v = randomIndex(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
    expect(randomIndex(1)).toBe(0);
  });
});

describe("generateName", () => {
  it("joins four wordlist words with dashes", () => {
    const parts = generateName().split("-");
    expect(parts).toHaveLength(4);
    for (const p of parts) expect(WORDLIST).toContain(p);
  });

  it("does not repeat itself", () => {
    const names = new Set(Array.from({ length: 50 }, () => generateName()));
    expect(names.size).toBe(50);
  });
});

describe("estimateStrength", () => {
  it("calls short dictionary-ish names weak", () => {
    expect(estimateStrength("taco").level).toBe("weak");
  });

  it("calls generated names strong", () => {
    const s = estimateStrength(generateName());
    expect(s.level).toBe("strong");
    expect(s.bits).toBeGreaterThanOrEqual(50);
  });

  it("scores wordlist names by word count, not characters", () => {
    // two long words are still only two guesses-from-a-list
    expect(estimateStrength(`${WORDLIST[0]}-${WORDLIST[1]}`).level).toBe("weak");
  });

  it("gives a human-readable message", () => {
    expect(estimateStrength("taco").message.length).toBeGreaterThan(0);
  });
});
