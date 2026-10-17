/**
 * RGA (Replicated Growable Array): a sequence CRDT for text.
 *
 * Every UTF-16 code unit is an element with a permanent id (counter, replica). Inserts say
 * "after element X"; deletes hide elements (tombstones) instead of removing them, so later
 * inserts can still find their anchor. Any set of ops, applied in any order, any number of
 * times, yields the same text on every replica.
 */

export interface ElemId {
  c: number; // Lamport counter
  r: string; // replica id: 16 lowercase hex chars, random per visit
}

/** The ids (r, c), (r, c+1) … (r, c+n-1). */
export interface IdRange {
  r: string;
  c: number;
  n: number;
}

export type Op =
  | { k: "ins"; id: ElemId; after: ElemId | null; text: string } // chars get ids (id.c + i, id.r)
  | { k: "del"; at: ElemId; ranges: IdRange[] } // at = this op's own Lamport stamp
  | { k: "undel"; at: ElemId; ranges: IdRange[] };

/** Reserved replica for importing Phase 1 notes (deterministic ids across importers). */
export const IMPORT_REPLICA = "0000000000000000";

/** Total order on ids: counter first, then replica. Bigger = newer (or tie-broken). */
export function compareIds(a: ElemId, b: ElemId): number {
  if (a.c !== b.c) return a.c - b.c;
  return a.r < b.r ? -1 : a.r > b.r ? 1 : 0;
}

interface Node {
  c: number;
  r: string;
  ch: string; // one UTF-16 code unit
  stamp: ElemId | null; // latest del/undel stamp applied (last-writer-wins)
  deleted: boolean;
}

const key = (r: string, c: number) => `${r}:${c}`;

export class Rga {
  readonly replica: string;
  private nodes: Node[] = []; // document order, tombstones included
  private byId = new Map<string, Node>();
  private clock = 0; // largest counter seen
  private buffered: Op[] = []; // remote ops waiting for an unknown reference
  private cachedText: string | null = "";

  constructor(replica: string) {
    this.replica = replica;
  }

  text(): string {
    if (this.cachedText === null) {
      let s = "";
      for (const n of this.nodes) if (!n.deleted) s += n.ch;
      this.cachedText = s;
    }
    return this.cachedText;
  }

  get length(): number {
    return this.text().length;
  }

  pendingCount(): number {
    return this.buffered.length;
  }

  // ---- local edits: apply immediately and return the op to broadcast ----

  insert(index: number, text: string): Op {
    const after = index === 0 ? null : this.idAt(index - 1);
    const op: Op = { k: "ins", id: { c: this.clock + 1, r: this.replica }, after, text };
    this.applyNow(op);
    return op;
  }

  delete(index: number, count: number): Op | null {
    const ids: ElemId[] = [];
    let seen = 0;
    for (const n of this.nodes) {
      if (n.deleted) continue;
      if (seen >= index + count) break;
      if (seen >= index) ids.push({ c: n.c, r: n.r });
      seen++;
    }
    if (ids.length === 0) return null;
    return this.stampOp("del", toRanges(ids));
  }

  deleteIds(ranges: IdRange[]): Op {
    return this.stampOp("del", ranges);
  }

  undeleteIds(ranges: IdRange[]): Op {
    return this.stampOp("undel", ranges);
  }

  private stampOp(k: "del" | "undel", ranges: IdRange[]): Op {
    const op: Op = { k, at: { c: this.clock + 1, r: this.replica }, ranges };
    this.applyNow(op);
    return op;
  }

  // ---- remote ops ----

  /** Idempotent. Buffers ops that reference unknown elements. True if the visible text changed. */
  apply(op: Op): boolean {
    if (!this.ready(op)) {
      if (!this.isDuplicate(op)) this.buffered.push(op);
      return false;
    }
    let changed = this.applyNow(op);
    // Anything buffered may now be applicable; repeat until no progress.
    let progress = true;
    while (progress && this.buffered.length > 0) {
      progress = false;
      for (let i = 0; i < this.buffered.length; i++) {
        const b = this.buffered[i];
        if (!this.ready(b)) continue;
        this.buffered.splice(i, 1);
        changed = this.applyNow(b) || changed;
        progress = true;
        break;
      }
    }
    return changed;
  }

  private ready(op: Op): boolean {
    if (op.k === "ins") return op.after === null || this.byId.has(key(op.after.r, op.after.c));
    return op.ranges.every((rg) => this.knowsRange(rg));
  }

  private knowsRange(rg: IdRange): boolean {
    for (let i = 0; i < rg.n; i++) if (!this.byId.has(key(rg.r, rg.c + i))) return false;
    return true;
  }

  private isDuplicate(op: Op): boolean {
    const same = JSON.stringify(op);
    return this.buffered.some((b) => JSON.stringify(b) === same);
  }

  /** Applies an op whose references are all known. */
  private applyNow(op: Op): boolean {
    if (op.k === "ins") return this.integrateInsert(op);
    this.clock = Math.max(this.clock, op.at.c);
    let changed = false;
    for (const rg of op.ranges) {
      for (let i = 0; i < rg.n; i++) {
        const n = this.byId.get(key(rg.r, rg.c + i))!;
        if (n.stamp && compareIds(op.at, n.stamp) <= 0) continue; // an equal or newer stamp already won
        n.stamp = op.at;
        const deleted = op.k === "del";
        if (n.deleted !== deleted) {
          n.deleted = deleted;
          changed = true;
        }
      }
    }
    if (changed) this.cachedText = null;
    return changed;
  }

  private integrateInsert(op: Extract<Op, { k: "ins" }>): boolean {
    if (op.text.length === 0 || this.byId.has(key(op.id.r, op.id.c))) return false; // idempotent
    this.clock = Math.max(this.clock, op.id.c + op.text.length - 1);
    let pos = op.after === null ? 0 : this.nodes.indexOf(this.byId.get(key(op.after.r, op.after.c))!) + 1;
    // Classic RGA: skip elements with a bigger id (newer or tie-winning inserts at the same spot).
    while (pos < this.nodes.length && compareIds(this.nodes[pos], op.id) > 0) pos++;
    const fresh: Node[] = [];
    for (let i = 0; i < op.text.length; i++) {
      const n: Node = { c: op.id.c + i, r: op.id.r, ch: op.text[i], stamp: null, deleted: false };
      fresh.push(n);
      this.byId.set(key(n.r, n.c), n);
    }
    this.nodes.splice(pos, 0, ...fresh);
    this.cachedText = null;
    return true;
  }

  // ---- positions ----

  /** The visible element at a visible index (0 ≤ index < length). */
  idAt(index: number): ElemId {
    let seen = 0;
    for (const n of this.nodes) {
      if (n.deleted) continue;
      if (seen === index) return { c: n.c, r: n.r };
      seen++;
    }
    throw new RangeError(`idAt(${index}) out of range (length ${seen})`);
  }

  /** Number of visible elements before the element (also works for tombstones). */
  indexOf(id: ElemId): number {
    const target = this.byId.get(key(id.r, id.c));
    if (!target) throw new RangeError(`unknown element ${id.r}:${id.c}`);
    let seen = 0;
    for (const n of this.nodes) {
      if (n === target) return seen;
      if (!n.deleted) seen++;
    }
    return seen;
  }

  isVisible(id: ElemId): boolean {
    const n = this.byId.get(key(id.r, id.c));
    return n !== undefined && !n.deleted;
  }
}

/** Merges ids into runs of consecutive counters from the same replica, preserving order. */
function toRanges(ids: ElemId[]): IdRange[] {
  const out: IdRange[] = [];
  for (const id of ids) {
    const last = out[out.length - 1];
    if (last && last.r === id.r && last.c + last.n === id.c) last.n++;
    else out.push({ r: id.r, c: id.c, n: 1 });
  }
  return out;
}
