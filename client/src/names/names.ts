import { WORDLIST } from "./wordlist";

/** Canonical form of a note name. Equal names → equal keys, so this must be stable forever. */
export function normalizeName(raw: string): string {
  return raw.normalize("NFC").trim().toLowerCase();
}

/** Uniform random integer in [0, n), without modulo bias. */
export function randomIndex(n: number): number {
  const range = 0x1_0000_0000; // 2^32 possible Uint32 values
  const limit = range - (range % n); // largest multiple of n that fits
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return buf[0] % n;
}

export function generateName(count = 4, words: readonly string[] = WORDLIST): string {
  return Array.from({ length: count }, () => words[randomIndex(words.length)]).join("-");
}

export type StrengthLevel = "weak" | "fair" | "strong";

export interface Strength {
  bits: number;
  level: StrengthLevel;
  message: string;
}

const MESSAGES: Record<StrengthLevel, string> = {
  weak: "weak name: someone guessing common words could open this note",
  fair: "fair name: hard to stumble on, not hard to brute-force",
  strong: "strong name: practically unguessable",
};

const DEFAULT_WORDSET = new Set(WORDLIST);

/** Rough entropy estimate in bits. Deliberately pessimistic about wordlist names. */
export function estimateStrength(name: string, words: readonly string[] = WORDLIST): Strength {
  const bits = estimateBits(name, words);
  const level: StrengthLevel = bits < 35 ? "weak" : bits < 50 ? "fair" : "strong";
  return { bits: Math.round(bits), level, message: MESSAGES[level] };
}

function estimateBits(name: string, words: readonly string[]): number {
  const wordset = words === WORDLIST ? DEFAULT_WORDSET : new Set(words);
  const parts = name.split("-");
  if (parts.length >= 2 && parts.every((p) => wordset.has(p))) {
    return parts.length * Math.log2(words.length);
  }
  let pool = 0;
  if (/[a-z]/.test(name)) pool += 26;
  if (/[0-9]/.test(name)) pool += 10;
  if (/[^a-z0-9]/.test(name)) pool += 33;
  return pool === 0 ? 0 : name.length * Math.log2(pool);
}
