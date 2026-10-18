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

/**
 * Snapshot format (frozen once stored; bump `v` to change it). Runs of consecutive ids from one
 * replica, adjacent in the document, with the same visibility stamp:
 * `[repIndex, firstCounter, text]` (never stamped) or
 * `[repIndex, firstCounter, text, deleted 0|1, stampCounter, stampRepIndex]`.
 */
export interface RgaState {
  v: 1;
  clock: number;
  reps: string[];
  runs: (string | number)[][];
}

interface Node {
  c: number;
  r: string;
  ch: string; // one UTF-16 code unit
  stamp: ElemId | null; // latest del/undel stamp applied (last-writer-wins)
  deleted: boolean;
  chunk: Chunk;
}

/** Nodes live in chunks, so positions are found by skipping whole chunks instead of single nodes. */
interface Chunk {
  nodes: Node[];
  visible: number;
  text: string | null; // cached visible text of this chunk
}

const CHUNK_TARGET = 512;
const CHUNK_MAX = 1024;

/** id → node, two-level (replica → counter) so the hot path hashes numbers, not built strings. */
class IdIndex {
  private byReplica = new Map<string, Map<number, Node>>();
  get(r: string, c: number): Node | undefined {
    return this.byReplica.get(r)?.get(c);
  }
  has(r: string, c: number): boolean {
    return this.byReplica.get(r)?.has(c) ?? false;
  }
  set(n: Node): void {
    let m = this.byReplica.get(n.r);
    if (!m) this.byReplica.set(n.r, (m = new Map()));
    m.set(n.c, n);
  }
}

export class Rga {
  readonly replica: string;
  private chunks: Chunk[] = []; // document order, tombstones included
  private byId = new IdIndex();
  private clock = 0; // largest counter seen
  private visibleCount = 0;
  private buffered: Op[] = []; // remote ops waiting for an unknown reference
  private cachedText: string | null = "";

  constructor(replica: string) {
    this.replica = replica;
  }

  text(): string {
    if (this.cachedText === null) this.cachedText = this.chunks.map(chunkText).join("");
    return this.cachedText;
  }

  get length(): number {
    return this.visibleCount;
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
    if (count > 0 && index < this.visibleCount) {
      let { ci, off } = this.visiblePosition(index);
      while (ci < this.chunks.length && ids.length < count) {
        const n = this.chunks[ci].nodes[off];
        if (!n.deleted) ids.push({ c: n.c, r: n.r });
        if (++off >= this.chunks[ci].nodes.length) {
          ci++;
          off = 0;
        }
      }
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
    if (op.k === "ins") return op.after === null || this.byId.has(op.after.r, op.after.c);
    return op.ranges.every((rg) => this.knowsRange(rg));
  }

  private knowsRange(rg: IdRange): boolean {
    for (let i = 0; i < rg.n; i++) if (!this.byId.has(rg.r, rg.c + i)) return false;
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
        const n = this.byId.get(rg.r, rg.c + i)!;
        if (n.stamp && compareIds(op.at, n.stamp) <= 0) continue; // an equal or newer stamp already won
        n.stamp = op.at;
        const deleted = op.k === "del";
        if (n.deleted === deleted) continue;
        n.deleted = deleted;
        n.chunk.visible += deleted ? -1 : 1;
        n.chunk.text = null;
        this.visibleCount += deleted ? -1 : 1;
        changed = true;
      }
    }
    if (changed) this.cachedText = null;
    return changed;
  }

  private integrateInsert(op: Extract<Op, { k: "ins" }>): boolean {
    if (op.text.length === 0) return false;
    // Idempotent, also for partial overlap: a replica may already hold some chars of this run (it got
    // them from smaller ops; `opsFromState` re-sends merged runs). Integrate only the missing stretches.
    let known = 0;
    for (let i = 0; i < op.text.length; i++) if (this.byId.has(op.id.r, op.id.c + i)) known++;
    if (known === op.text.length) return false;
    if (known > 0) {
      let changed = false;
      for (let i = 0; i < op.text.length; ) {
        if (this.byId.has(op.id.r, op.id.c + i)) {
          i++;
          continue;
        }
        let j = i;
        while (j < op.text.length && !this.byId.has(op.id.r, op.id.c + j)) j++;
        const after = i === 0 ? op.after : { c: op.id.c + i - 1, r: op.id.r };
        changed = this.integrateInsert({ k: "ins", id: { c: op.id.c + i, r: op.id.r }, after, text: op.text.slice(i, j) }) || changed;
        i = j;
      }
      return changed;
    }
    this.clock = Math.max(this.clock, op.id.c + op.text.length - 1);

    // Position just after `after` (or the document start)…
    let ci = 0;
    let off = 0;
    if (op.after !== null) {
      ({ ci, off } = this.positionOf(this.byId.get(op.after.r, op.after.c)!));
      off++;
    }
    // …then classic RGA: skip elements with a bigger id (newer or tie-winning inserts at the same spot).
    for (;;) {
      if (ci < this.chunks.length && off >= this.chunks[ci].nodes.length) {
        ci++;
        off = 0;
        continue;
      }
      if (ci >= this.chunks.length || compareIds(this.chunks[ci].nodes[off], op.id) <= 0) break;
      off++;
    }

    const fresh: Node[] = [];
    for (let i = 0; i < op.text.length; i++) {
      const n = { c: op.id.c + i, r: op.id.r, ch: op.text[i], stamp: null, deleted: false } as Node;
      fresh.push(n);
      this.byId.set(n);
    }
    this.insertNodes(ci, off, fresh);
    this.visibleCount += fresh.length;
    this.cachedText = null;
    return true;
  }

  /** Inserts nodes before position (ci, off); ci === chunks.length means the end. */
  private insertNodes(ci: number, off: number, fresh: Node[]): void {
    if (this.chunks.length === 0) {
      this.chunks = makeChunks(fresh);
      return;
    }
    if (ci >= this.chunks.length) {
      ci = this.chunks.length - 1;
      off = this.chunks[ci].nodes.length;
    }
    const target = this.chunks[ci];
    if (target.nodes.length + fresh.length <= CHUNK_MAX) {
      const tail = target.nodes.splice(off);
      for (const n of fresh) {
        n.chunk = target;
        target.nodes.push(n);
      }
      for (const n of tail) target.nodes.push(n);
      target.visible += fresh.length;
      target.text = null;
      if (target.nodes.length > CHUNK_MAX - CHUNK_TARGET / 2) this.chunks.splice(ci, 1, ...makeChunks(target.nodes));
      return;
    }
    // Big insert: split the target around `off` and drop whole new chunks in between.
    const left = target.nodes.slice(0, off);
    const right = target.nodes.slice(off);
    const replacement = [left, fresh, right].filter((ns) => ns.length > 0).flatMap((ns) => makeChunks(ns));
    this.chunks.splice(ci, 1, ...replacement);
  }

  // ---- positions ----

  private positionOf(node: Node): { ci: number; off: number } {
    return { ci: this.chunks.indexOf(node.chunk), off: node.chunk.nodes.indexOf(node) };
  }

  /** Position of the visible element at a visible index. */
  private visiblePosition(index: number): { ci: number; off: number } {
    let left = index;
    for (let ci = 0; ci < this.chunks.length; ci++) {
      const chunk = this.chunks[ci];
      if (left >= chunk.visible) {
        left -= chunk.visible;
        continue;
      }
      for (let off = 0; off < chunk.nodes.length; off++) {
        if (chunk.nodes[off].deleted) continue;
        if (left === 0) return { ci, off };
        left--;
      }
    }
    throw new RangeError(`index ${index} out of range (length ${this.visibleCount})`);
  }

  /** The visible element at a visible index (0 ≤ index < length). */
  idAt(index: number): ElemId {
    const { ci, off } = this.visiblePosition(index);
    const n = this.chunks[ci].nodes[off];
    return { c: n.c, r: n.r };
  }

  /** Number of visible elements before the element (also works for tombstones). */
  indexOf(id: ElemId): number {
    const node = this.byId.get(id.r, id.c);
    if (!node) throw new RangeError(`unknown element ${id.r}:${id.c}`);
    let seen = 0;
    for (const chunk of this.chunks) {
      if (chunk === node.chunk) break;
      seen += chunk.visible;
    }
    for (const n of node.chunk.nodes) {
      if (n === node) break;
      if (!n.deleted) seen++;
    }
    return seen;
  }

  isVisible(id: ElemId): boolean {
    const n = this.byId.get(id.r, id.c);
    return n !== undefined && !n.deleted;
  }

  // ---- snapshots ----

  toState(): RgaState {
    const reps: string[] = [];
    const repIndex = new Map<string, number>();
    const rep = (r: string) => {
      let i = repIndex.get(r);
      if (i === undefined) {
        i = reps.length;
        reps.push(r);
        repIndex.set(r, i);
      }
      return i;
    };
    const runs: (string | number)[][] = [];
    let run: { r: string; c: number; chars: string[]; last: Node } | null = null;
    const flush = () => {
      if (!run) return;
      const n = run.last;
      const entry: (string | number)[] = [rep(run.r), run.c, run.chars.join("")];
      if (n.stamp) entry.push(n.deleted ? 1 : 0, n.stamp.c, rep(n.stamp.r));
      runs.push(entry);
    };
    for (const chunk of this.chunks) {
      for (const n of chunk.nodes) {
        if (run && run.r === n.r && run.last.c + 1 === n.c && sameVisibility(run.last, n)) {
          run.chars.push(n.ch);
          run.last = n;
          continue;
        }
        flush();
        run = { r: n.r, c: n.c, chars: [n.ch], last: n };
      }
    }
    flush();
    return { v: 1, clock: this.clock, reps, runs };
  }

  static fromState(replica: string, state: RgaState): Rga {
    if (state.v !== 1) throw new Error(`unsupported snapshot version ${String(state.v)}`);
    const rga = new Rga(replica);
    const all: Node[] = [];
    for (const entry of state.runs) {
      const r = state.reps[entry[0] as number];
      const c = entry[1] as number;
      const text = entry[2] as string;
      const stamped = entry.length > 3;
      const deleted = stamped && entry[3] === 1;
      const stamp = stamped ? { c: entry[4] as number, r: state.reps[entry[5] as number] } : null;
      for (let i = 0; i < text.length; i++) {
        const n = { c: c + i, r, ch: text[i], stamp, deleted } as Node;
        all.push(n);
        rga.byId.set(n);
        if (!deleted) rga.visibleCount++;
      }
    }
    rga.chunks = makeChunks(all);
    rga.clock = state.clock;
    rga.cachedText = null;
    return rga;
  }
}

/**
 * Turns a snapshot back into ops (used to re-send history a server lost). Inserts come in document
 * order, each run anchored on the element just before it (tombstones included), then every stamped
 * run gets its del/undel. Applying these to any replica holding a causally-closed subset of the
 * state's ops makes it equal to the state; applying them to a full replica changes nothing.
 */
export function opsFromState(state: RgaState): Op[] {
  const inserts: Op[] = [];
  const stamps: Op[] = [];
  let prev: ElemId | null = null;
  for (const entry of state.runs) {
    const r = state.reps[entry[0] as number];
    const c = entry[1] as number;
    const text = entry[2] as string;
    inserts.push({ k: "ins", id: { c, r }, after: prev, text });
    prev = { c: c + text.length - 1, r };
    if (entry.length > 3) {
      const at = { c: entry[4] as number, r: state.reps[entry[5] as number] };
      stamps.push({ k: entry[3] === 1 ? "del" : "undel", at, ranges: [{ r, c, n: text.length }] });
    }
  }
  return [...inserts, ...stamps];
}

function chunkText(chunk: Chunk): string {
  if (chunk.text === null) {
    let s = "";
    for (const n of chunk.nodes) if (!n.deleted) s += n.ch;
    chunk.text = s;
  }
  return chunk.text;
}

/** Splits nodes into fresh chunks of CHUNK_TARGET and points each node at its chunk. */
function makeChunks(nodes: Node[]): Chunk[] {
  const out: Chunk[] = [];
  for (let i = 0; i < nodes.length; i += CHUNK_TARGET) {
    const slice = nodes.slice(i, i + CHUNK_TARGET);
    const chunk: Chunk = { nodes: slice, visible: 0, text: null };
    for (const n of slice) {
      n.chunk = chunk;
      if (!n.deleted) chunk.visible++;
    }
    out.push(chunk);
  }
  return out;
}

function sameVisibility(a: Node, b: Node): boolean {
  if (a.deleted !== b.deleted) return false;
  if (a.stamp === null || b.stamp === null) return a.stamp === b.stamp;
  return a.stamp.c === b.stamp.c && a.stamp.r === b.stamp.r;
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
