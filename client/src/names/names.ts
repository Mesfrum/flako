import { WORDLIST } from "./wordlist";

/** Canonical form of a note name. Equal names → equal keys, so this must be stable forever. */
export function normalizeName(raw: string): string {
  // Lowercase BEFORE NFC: lowercasing can create sequences NFC composes further, so this
  // order is a fixed point (normalizeName(normalizeName(x)) === normalizeName(x)).
  return raw.toLowerCase().normalize("NFC").trim();
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
  const wordset = words === WORDLIST ? DEFAULT_WORDSET : new Set(words);
  const parts = name.split("-");
  const generated = parts.length >= 2 && parts.every((p) => wordset.has(p));
  // Generator-shaped names: each word is a uniform pick from the list. Anything a person
  // typed is guessed with dictionaries and patterns, not brute force: ~2 bits per character
  // (roughly the entropy of English text), and never "strong", however long it is.
  const bits = generated ? parts.length * Math.log2(words.length) : name.length * 2;
  let level: StrengthLevel = bits < 35 ? "weak" : bits < 50 ? "fair" : "strong";
  if (!generated && level === "strong") level = "fair";
  return { bits: Math.round(bits), level, message: MESSAGES[level] };
}
