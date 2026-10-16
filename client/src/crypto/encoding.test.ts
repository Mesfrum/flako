import { describe, expect, it } from "vitest";
import { fromBase64, toBase64, toBase64Url, utf8 } from "./encoding";

describe("encoding", () => {
  it("round-trips arbitrary bytes through base64", () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it("matches the standard base64 alphabet", () => {
    expect(toBase64(utf8("hello"))).toBe("aGVsbG8=");
    expect(toBase64(new Uint8Array([0xfb, 0xff]))).toBe("+/8=");
  });

  it("produces URL-safe base64 without padding", () => {
    expect(toBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
  });

  it("encodes 32 bytes as a 43-character id", () => {
    expect(toBase64Url(new Uint8Array(32).fill(255))).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("encodes text as UTF-8", () => {
    expect(Array.from(utf8("é"))).toEqual([0xc3, 0xa9]);
  });
});
