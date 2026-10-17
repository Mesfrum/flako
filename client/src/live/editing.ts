import type { ElemId, Rga } from "./crdt/rga";

/** At `index`, remove `remove` UTF-16 units and insert `insert`. */
export interface Splice {
  index: number;
  remove: number;
  insert: string;
}

const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Turns "the textarea went from prev to next" into one splice. `caret` is selectionEnd after the
 * change; it settles ambiguous cases ("aa" → "aaa" with the caret at 1 inserted at 0). Splice
 * edges never fall inside a surrogate pair.
 */
export function spliceFromChange(prev: string, next: string, caret: number): Splice | null {
  const maxShared = Math.min(prev.length, next.length);
  // Common suffix, never reaching left of the caret in `next`.
  let s = 0;
  const suffixLimit = Math.min(maxShared, Math.max(0, next.length - caret));
  while (s < suffixLimit && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;
  // Common prefix in what's left.
  let p = 0;
  while (p < maxShared - s && prev[p] === next[p]) p++;
  if (p === prev.length - s && p === next.length - s) return null;

  // Move edges outward so neither string is cut between a high and a low surrogate.
  while (p > 0 && (isLow(prev.charCodeAt(p)) || isLow(next.charCodeAt(p)))) p--;
  while (s > 0 && (isLow(prev.charCodeAt(prev.length - s)) || isLow(next.charCodeAt(next.length - s)))) s--;

  return { index: p, remove: prev.length - s - p, insert: next.slice(p, next.length - s) };
}

/** A position stored as "just after element X" (null = document start); survives remote edits. */
export type Anchor = ElemId | null;

export function toAnchor(rga: Rga, index: number): Anchor {
  return index <= 0 ? null : rga.idAt(index - 1);
}

export function fromAnchor(rga: Rga, a: Anchor): number {
  if (a === null) return 0;
  return rga.indexOf(a) + (rga.isVisible(a) ? 1 : 0);
}
