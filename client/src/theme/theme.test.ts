import { describe, expect, it } from "vitest";
import { effectiveTheme, readTheme, writeTheme, THEME_KEY } from "./theme";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}

const broken = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

describe("readTheme", () => {
  it("returns a stored light or dark choice", () => {
    expect(readTheme(memoryStorage({ [THEME_KEY]: "dark" }))).toBe("dark");
    expect(readTheme(memoryStorage({ [THEME_KEY]: "light" }))).toBe("light");
  });

  it("treats nothing stored, junk, or blocked storage as no choice", () => {
    expect(readTheme(memoryStorage())).toBeNull();
    expect(readTheme(memoryStorage({ [THEME_KEY]: "purple" }))).toBeNull();
    expect(readTheme(broken)).toBeNull();
  });
});

describe("writeTheme", () => {
  it("stores the choice", () => {
    const s = memoryStorage();
    writeTheme(s, "dark");
    expect(s.data.get(THEME_KEY)).toBe("dark");
  });

  it("never throws when storage is blocked", () => {
    expect(() => writeTheme(broken, "light")).not.toThrow();
  });
});

describe("effectiveTheme", () => {
  it("follows the system until the user chooses", () => {
    expect(effectiveTheme(null, true)).toBe("dark");
    expect(effectiveTheme(null, false)).toBe("light");
  });

  it("a stored choice wins over the system", () => {
    expect(effectiveTheme("light", true)).toBe("light");
    expect(effectiveTheme("dark", false)).toBe("dark");
  });
});
