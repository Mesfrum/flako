import { IMPORT_REPLICA, type Op, type Rga } from "./crdt/rga";
import { fromAnchor, spliceFromChange } from "./editing";

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;

/**
 * A Phase 1 note's text as CRDT inserts with DETERMINISTIC ids: replica IMPORT_REPLICA, and the
 * character at UTF-16 index i gets counter i + 1. Two people importing the same note at the same
 * time produce identical ops, so idempotence keeps exactly one copy.
 */
export function importOps(text: string, chunkChars = 65_536): Op[] {
  const ops: Op[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + chunkChars, text.length);
    if (end < text.length && isHigh(text.charCodeAt(end - 1))) end--; // keep surrogate pairs whole
    ops.push({
      k: "ins",
      id: { c: start + 1, r: IMPORT_REPLICA },
      after: start === 0 ? null : { c: start, r: IMPORT_REPLICA },
      text: text.slice(start, end),
    });
    start = end;
  }
  return ops;
}

/**
 * Applies text a Phase 1 tab typed but never saved (`pendingText`, edited from `legacyText`) on
 * top of the imported note, as local ops on `rga`. Positions are import ids, so it lands in the
 * right place even after others have edited. Returns the ops (already applied) to send.
 */
export function legacySpliceOps(legacyText: string, pendingText: string, rga: Rga): Op[] {
  const s = spliceFromChange(legacyText, pendingText, 0); // caret 0: longest common suffix, minimal change
  if (!s) return [];
  const ops: Op[] = [];
  if (s.remove > 0) ops.push(rga.deleteIds([{ r: IMPORT_REPLICA, c: s.index + 1, n: s.remove }]));
  if (s.insert.length > 0) {
    const anchor = s.index === 0 ? null : { c: s.index, r: IMPORT_REPLICA };
    ops.push(rga.insert(fromAnchor(rga, anchor), s.insert));
  }
  return ops;
}
