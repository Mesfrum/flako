import { DecryptError, decryptNote } from "../crypto/cipher";
import type { NoteKeys } from "../crypto/derive";
import type { NotesApi } from "../notes/api";
import type { PendingStore } from "../notes/pending";
import { Rga, opsFromState, type Op, type RgaState } from "./crdt/rga";
import { UndoManager } from "./crdt/undo";
import { fromAnchor, spliceFromChange, toAnchor, type Anchor } from "./editing";
import { importOps, legacySpliceOps } from "./importLegacy";
import type { Outbox } from "./outbox";
import {
  CLOSE_ROOM_FULL,
  type ClientMsg,
  type OpsPayload,
  type PresencePayload,
  type SealedWire,
  type ServerMsg,
  type SnapshotPayload,
} from "./protocol";
import { seal, unseal } from "./sealed";

// ---- transport (injected: the browser WebSocket in the app, FakeHub in tests) ----

export interface Socket {
  send(msg: ClientMsg): void;
  close(): void;
}
export interface SocketHandlers {
  onOpen(): void;
  onMessage(msg: ServerMsg): void;
  onClose(code: number): void;
}
export type Connect = (noteId: string, handlers: SocketHandlers) => Socket;

// ---- what React renders ----

export type LiveStatus =
  | { kind: "deriving" }
  | { kind: "connecting" }
  | { kind: "ready" }
  | { kind: "unreadable" }
  | { kind: "error"; message: string };

export interface RemoteCursor {
  from: number;
  color: string;
  start: number;
  end: number;
}

export interface LiveSnapshot {
  status: LiveStatus;
  text: string;
  selection: { start: number; end: number }; // where the local caret must be
  conn: "live" | "connecting" | "offline" | "busy";
  here: number; // includes me; 0 until welcome
  cursors: RemoteCursor[];
  full: boolean;
  unsent: number; // outbox batches + an unbatched one
}

export interface LiveNoteDeps {
  connect: Connect;
  api: Pick<NotesApi, "getNote">;
  outbox: Outbox;
  legacyPending: PendingStore;
  derive: (name: string) => Promise<NoteKeys>;
  replica?: string;
  now?: () => number;
  batchMs?: number;
  presenceMs?: number;
  snapshotEvery?: number;
  maxTextBytes?: number;
  heartbeatMs?: number;
  pongTimeoutMs?: number;
}

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

/** Cursor colours; one is picked at random per visit, so a colour doesn't identify a person. */
export const CURSOR_COLORS = ["#e4572e", "#d65db1", "#f3a712", "#669bbc", "#a8c686", "#b56576", "#6d597a", "#2a9d8f"];

const encoder = new TextEncoder();

// Server frame limit is 256 KiB of ciphertext per batch. An insert piece is at most 16 Ki UTF-16
// units (≤ 96 KiB of JSON even if every char is \u-escaped) and a batch at most 192 KiB of JSON.
const MAX_INSERT_UNITS = 16_384;
const MAX_BATCH_BYTES = 192 << 10;
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** Splits big inserts into consecutive pieces (ordinary RGA inserts, so they converge the same). */
function splitLargeInserts(ops: Op[]): Op[] {
  const out: Op[] = [];
  for (const op of ops) {
    if (op.k !== "ins" || op.text.length <= MAX_INSERT_UNITS) {
      out.push(op);
      continue;
    }
    let start = 0;
    let after = op.after;
    while (start < op.text.length) {
      let end = Math.min(start + MAX_INSERT_UNITS, op.text.length);
      if (end < op.text.length && isHigh(op.text.charCodeAt(end - 1))) end--;
      const id = { c: op.id.c + start, r: op.id.r };
      out.push({ k: "ins", id, after, text: op.text.slice(start, end) });
      after = { c: op.id.c + end - 1, r: op.id.r };
      start = end;
    }
  }
  return out;
}

/** Groups ops into batches whose JSON stays under MAX_BATCH_BYTES. */
function intoBatches(ops: Op[]): Op[][] {
  const batches: Op[][] = [];
  let current: Op[] = [];
  let size = 0;
  for (const op of splitLargeInserts(ops)) {
    const bytes = encoder.encode(JSON.stringify(op)).length;
    if (current.length > 0 && size + bytes > MAX_BATCH_BYTES) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(op);
    size += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** UTF-8 size, computed only when it could matter (a UTF-16 unit is at most 3 UTF-8 bytes). */
function exceeds(text: string, maxBytes: number): boolean {
  if (text.length * 3 <= maxBytes) return false;
  return encoder.encode(text).length > maxBytes;
}

/** What a server-side replica holds, as sorted runs per replica id (cheap to query, no per-char map). */
type RunIndex = Map<string, { c: number; n: number; stamp: string }[]>;

function indexState(state: RgaState): RunIndex {
  const index: RunIndex = new Map();
  for (const entry of state.runs) {
    const r = state.reps[entry[0] as number];
    const stamp = entry.length > 3 ? `${entry[3]}:${entry[4]}:${state.reps[entry[5] as number]}` : "";
    let runs = index.get(r);
    if (!runs) index.set(r, (runs = []));
    runs.push({ c: entry[1] as number, n: (entry[2] as string).length, stamp });
  }
  for (const runs of index.values()) runs.sort((x, y) => x.c - y.c);
  return index;
}

/** True when every id in (r, c .. c+n-1) is held; with `stamp`, also stamped exactly that way. */
function holdsAll(index: RunIndex, r: string, c: number, n: number, stamp?: string): boolean {
  const runs = index.get(r);
  if (!runs) return n === 0;
  const end = c + n;
  while (c < end) {
    let lo = 0;
    let hi = runs.length - 1;
    let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (runs[mid].c <= c) {
        hit = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const run = hit >= 0 ? runs[hit] : undefined;
    if (!run || c >= run.c + run.n) return false;
    if (stamp !== undefined && run.stamp !== stamp) return false;
    c = run.c + run.n;
  }
  return true;
}

/**
 * The ops the server's replica lacks, taken from my state. An insert the server holds in part is cut
 * down to its missing stretches, each anchored after the char before it (`after = {c - 1, r}`): a tab
 * running older code drops an insert whose first id it already knows, so never send one.
 */
function opsServerLacks(mine: Rga, server: Rga): Op[] {
  const index = indexState(server.toState());
  const out: Op[] = [];
  for (const op of opsFromState(mine.toState())) {
    if (op.k === "ins") {
      const n = op.text.length;
      if (holdsAll(index, op.id.r, op.id.c, n)) continue;
      if (!holdsAll(index, op.id.r, op.id.c, 1) && !holdsAny(index, op.id.r, op.id.c, n)) {
        out.push(op); // none of it is there: the whole run, as is
        continue;
      }
      for (let i = 0; i < n; ) {
        if (holdsAll(index, op.id.r, op.id.c + i, 1)) {
          i++;
          continue;
        }
        let j = i + 1;
        while (j < n && !holdsAll(index, op.id.r, op.id.c + j, 1)) j++;
        const after = i === 0 ? op.after : { c: op.id.c + i - 1, r: op.id.r };
        out.push({ k: "ins", id: { c: op.id.c + i, r: op.id.r }, after, text: op.text.slice(i, j) });
        i = j;
      }
      continue;
    }
    const stamp = `${op.k === "del" ? 1 : 0}:${op.at.c}:${op.at.r}`;
    if (!op.ranges.every((rg) => holdsAll(index, rg.r, rg.c, rg.n, stamp))) out.push(op);
  }
  return out;
}

/** True when any id in (r, c .. c+n-1) is held. */
function holdsAny(index: RunIndex, r: string, c: number, n: number): boolean {
  const runs = index.get(r);
  if (!runs) return false;
  const end = c + n;
  // Runs are sorted and disjoint: only the last run starting before `end` can reach into [c, end).
  let lo = 0;
  let hi = runs.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid].c < end) {
      hit = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return hit >= 0 && runs[hit].c + runs[hit].n > c;
}

function randomReplica(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One note's live session: local-first CRDT editing, encrypted batching through an outbox,
 * catch-up and reconnect, heartbeat. Framework-free; React binds to it via useSyncExternalStore.
 */
export class LiveNote {
  private readonly name: string;
  private readonly deps: LiveNoteDeps;
  private readonly replica: string;
  private readonly color: string;
  private readonly listeners = new Set<() => void>();

  private snapshot: LiveSnapshot = {
    status: { kind: "deriving" },
    text: "",
    selection: { start: 0, end: 0 },
    conn: "connecting",
    here: 0,
    cursors: [],
    full: false,
    unsent: 0,
  };
  private keys: NoteKeys | null = null;
  private rga: Rga;
  private history: Op[] = []; // every op applied here, to re-base onto a snapshot if one arrives late
  private run = 0; // bumps on start/dispose; async work from an older run is ignored
  private disposed = false;
  private halted = false; // unreadable: stop syncing for good

  private socket: Socket | null = null;
  private open = false; // hello sent on the current socket
  private have = 0; // every seq ≤ have has been received
  private above = new Set<number>(); // received seqs > have (gaps not yet filled)
  private inbound: Promise<void> = Promise.resolve(); // server messages, processed strictly in order
  private outgoing: Promise<void> = Promise.resolve(); // batches, sealed strictly in order

  private queued: Op[] = []; // local ops not yet batched
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private cidCounter = 0;
  private retryDelay = FIRST_RETRY_MS;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;

  private undoer: UndoManager;
  private sealing = 0; // batches being sealed: in the CRDT but not yet in the outbox
  private lastSnapshotUpTo = 0;
  private composing = false;
  private held: Op[] = []; // remote ops waiting for IME composition to end
  private remote = new Map<number, { color: string; anchor: Anchor; head: Anchor }>();
  private presenceTimer: ReturnType<typeof setTimeout> | undefined;
  private presenceDue = false;
  private presenceOut: Promise<void> = Promise.resolve();
  private legacyChecked = false; // Phase 1 import / unsent-text merge happens once per session
  private welcomeHadSnapshot = false;
  // IV of the server op at `have` (and at seqs in `above`): sent as haveIv so a rewound log is noticed.
  private haveIvs = new Map<number, string>();
  // While catching up after a reset: what the server holds, to re-send only what it lacks at `synced`.
  private repair: Rga | null = null;
  private repairPending = false; // a reset happened and finishRepair hasn't run yet; survives reconnects
  private rebased = false; // a snapshot replaced the CRDT once: never replace it again (would drop text)
  // Ops that arrived on the current socket before its welcome (the hub may deliver a broadcast first).
  // Their seqs are newer than welcome.seq, so a reset must not forget them.
  private welcomed = false;
  private preWelcome = new Map<number, { iv: string; ops: Op[] }>();

  constructor(name: string, deps: LiveNoteDeps) {
    this.name = name;
    this.deps = deps;
    this.replica = deps.replica ?? randomReplica();
    this.color = CURSOR_COLORS[Math.floor(Math.random() * CURSOR_COLORS.length)];
    this.rga = new Rga(this.replica);
    this.undoer = new UndoManager(this.rga, 500);
  }

  // Arrow properties so React can pass them around without losing `this`.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): LiveSnapshot => this.snapshot;

  hasUnsentWork = (): boolean => this.queued.length > 0 || this.snapshot.unsent > 0;

  async start(): Promise<void> {
    const run = ++this.run;
    this.disposed = false;
    this.set({ status: { kind: "deriving" } });
    let keys: NoteKeys;
    try {
      keys = await this.deps.derive(this.name);
    } catch {
      if (run === this.run) this.set({ status: { kind: "error", message: "could not derive this note's key" } });
      return;
    }
    if (run !== this.run) return;
    this.keys = keys;
    this.set({ status: { kind: "connecting" }, conn: "connecting" });
    this.connect();
  }

  dispose(): void {
    if (this.disposed) return;
    clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
    void this.flush(); // persistence still happens: unbatched edits go to the outbox
    this.disposed = true;
    this.run++;
    this.stopHeartbeat();
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    clearTimeout(this.presenceTimer);
    this.presenceTimer = undefined;
    const s = this.socket;
    this.socket = null;
    this.open = false;
    s?.close();
  }

  /** The textarea now holds `next`; selection is where the browser put the caret. */
  change = (next: string, selStart: number, selEnd: number): void => {
    if (this.snapshot.status.kind !== "ready") return;
    const prev = this.rga.text();
    if (next.length > prev.length && exceeds(next, this.deps.maxTextBytes ?? 1 << 20)) {
      // Refused before anything exists, so nothing typed is lost; the textarea snaps back.
      this.set({ full: true, text: prev, selection: this.snapshot.selection });
      return;
    }
    const splice = spliceFromChange(prev, next, selEnd);
    if (splice) {
      const now = (this.deps.now ?? Date.now)();
      if (splice.remove > 0) {
        const op = this.rga.delete(splice.index, splice.remove);
        if (op) {
          this.undoer.record(op, now);
          this.local(op);
        }
      }
      if (splice.insert.length > 0) {
        const op = this.rga.insert(splice.index, splice.insert);
        this.undoer.record(op, now);
        this.local(op);
      }
    }
    this.setText({ full: false, selection: { start: selStart, end: selEnd } });
    this.schedulePresence();
  };

  select = (start: number, end: number): void => {
    const sel = this.snapshot.selection;
    if (sel.start === start && sel.end === end) return;
    this.undoer.breakGroup();
    this.set({ selection: { start, end } });
    this.schedulePresence();
  };

  /** Undo MY last edit step (never a collaborator's). */
  undo = (): void => this.applyUndo(this.undoer.undo());

  redo = (): void => this.applyUndo(this.undoer.redo());

  /** While an IME (phone keyboard, CJK input) composes, remote edits wait so the word isn't broken. */
  setComposing = (composing: boolean): void => {
    this.composing = composing;
    if (composing || this.held.length === 0) return;
    const held = this.held;
    this.held = [];
    this.applyRemote(held);
    this.maybeSnapshot();
  };

  private applyUndo(res: { ops: Op[]; caret: number } | null): void {
    if (!res || this.snapshot.status.kind !== "ready") return;
    for (const op of res.ops) this.local(op);
    this.setText({ selection: { start: res.caret, end: res.caret } });
    this.schedulePresence();
  }

  /** Reconnect now instead of waiting for the backoff (e.g. the browser fired "online"). */
  retryNow = (): void => {
    if (this.socket || !this.keys || this.disposed || this.halted) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.connect();
  };

  // ---- connection ----

  private connect(): void {
    if (!this.keys || this.disposed || this.halted) return;
    const run = this.run;
    const noteId = this.keys.id;
    let sock: Socket | null = null;
    const current = () => sock !== null && this.socket === sock && run === this.run && !this.disposed && !this.halted;
    sock = this.deps.connect(noteId, {
      onOpen: () => {
        if (!current()) return;
        this.open = true;
        this.welcomed = false;
        this.preWelcome.clear();
        const haveIv = this.have > 0 ? this.haveIvs.get(this.have) : undefined;
        this.send(haveIv ? { t: "hello", have: this.have, haveIv } : { t: "hello", have: this.have });
        for (const item of this.deps.outbox.list(noteId)) this.send({ t: "ops", ...item });
        this.startHeartbeat();
      },
      onMessage: (m) => {
        if (!current()) return;
        this.inbound = this.inbound
          .then(() => (current() ? this.handle(m) : undefined))
          .catch((err: unknown) => this.onInboundError(err));
      },
      onClose: (code) => {
        if (current()) this.dropSocket(code);
      },
    });
    this.socket = sock;
  }

  private dropSocket(code: number): void {
    this.socket = null;
    this.open = false;
    this.stopHeartbeat();
    this.set({ conn: code === CLOSE_ROOM_FULL ? "busy" : "offline" });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.halted || this.retryTimer !== undefined) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(delay * 2, MAX_RETRY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.snapshot.conn !== "busy") this.set({ conn: "connecting" });
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (!this.socket || !this.open) return;
      this.send({ t: "ping" });
      if (this.pongTimer !== undefined) return;
      this.pongTimer = setTimeout(() => {
        // No pong: the socket is dead even if it looks open (e.g. after laptop sleep).
        this.pongTimer = undefined;
        const dead = this.socket;
        this.dropSocket(1006);
        dead?.close();
      }, this.deps.pongTimeoutMs ?? 10_000);
    }, this.deps.heartbeatMs ?? 25_000);
  }

  private stopHeartbeat(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    this.pingTimer = undefined;
    this.pongTimer = undefined;
  }

  private send(msg: ClientMsg): void {
    this.socket?.send(msg);
  }

  // ---- inbound ----

  private async handle(m: ServerMsg): Promise<void> {
    const keys = this.keys!;
    switch (m.t) {
      case "welcome":
        this.set({ here: m.here });
        this.welcomeHadSnapshot = m.snapshot !== null;
        this.repair = null;
        // A reset starts a repair that must survive reconnects: if the socket drops before `synced`, the
        // next hello is a plain have:0 and the server cannot say "reset" again. So until finishRepair
        // completes, every welcome is treated like a reset.
        if (m.reset) this.repairPending = true;
        if (this.repairPending) {
          // The server's log isn't the one we knew (restored backup). Start the bookkeeping over, but
          // keep the visible text: the server's content is merged in as ops, never swapped in.
          this.have = 0;
          this.above.clear();
          this.haveIvs.clear();
          this.lastSnapshotUpTo = 0;
          // ...except ops this socket already delivered: they are the NEW log's ops past welcome.seq.
          for (const [seq, { iv }] of this.preWelcome) {
            if (seq <= m.seq) continue;
            this.above.add(seq);
            this.haveIvs.set(seq, iv);
          }
        }
        this.welcomed = true;
        if (m.seq > 0 && m.seqIv) this.haveIvs.set(m.seq, m.seqIv);
        if (this.repairPending) {
          this.repair = m.snapshot ? await this.mergeSnapshot(m.snapshot) : new Rga(this.replica);
          for (const [seq, { ops }] of this.preWelcome) if (seq > m.seq) for (const op of ops) this.repair.apply(op);
        } else if (m.snapshot) {
          if (this.rebased) await this.mergeSnapshot(m.snapshot);
          else await this.loadSnapshot(m.snapshot);
          this.lastSnapshotUpTo = Math.max(this.lastSnapshotUpTo, m.snapshot.upTo);
        }
        this.preWelcome.clear();
        return;
      case "op": {
        const payload = await unseal<OpsPayload>(keys.key, keys.id, "ops", m);
        if (this.repair) for (const op of payload.ops) this.repair.apply(op);
        if (!this.welcomed) this.preWelcome.set(m.seq, { iv: m.iv, ops: payload.ops });
        if (this.composing) this.held.push(...payload.ops);
        else this.applyRemote(payload.ops);
        this.haveIvs.set(m.seq, m.iv);
        this.markReceived(m.seq);
        this.maybeSnapshot();
        return;
      }
      case "ack": {
        const sent = this.deps.outbox.list(keys.id).find((item) => item.cid === m.cid);
        if (sent) this.haveIvs.set(m.seq, sent.iv); // the IV we sealed it with is the server's IV
        this.deps.outbox.remove(keys.id, m.cid);
        this.markReceived(m.seq);
        this.updateUnsent();
        this.maybeSnapshot();
        return;
      }
      case "synced": {
        this.have = Math.max(this.have, m.seq);
        this.absorb();
        this.finishRepair();
        await this.replayOutbox();
        if (!this.legacyChecked) {
          this.legacyChecked = true;
          await this.importLegacy(m.seq);
        }
        this.retryDelay = FIRST_RETRY_MS;
        this.set({ status: { kind: "ready" }, conn: "live" });
        this.updateUnsent();
        this.schedulePresence(); // let the others see where I am
        this.maybeSnapshot();
        return;
      }
      case "here": {
        const grew = m.n > this.snapshot.here;
        this.set({ here: m.n });
        if (grew) this.schedulePresence(); // newcomers see my cursor
        return;
      }
      case "pong":
        clearTimeout(this.pongTimer);
        this.pongTimer = undefined;
        return;
      case "presence": {
        const p = await unseal<PresencePayload>(keys.key, keys.id, "presence", m);
        this.remote.set(m.from, { color: p.color, anchor: p.anchor, head: p.head });
        this.set({ cursors: this.computeCursors() });
        return;
      }
      case "left":
        this.remote.delete(m.from);
        this.set({ cursors: this.computeCursors() });
        return;
    }
  }

  private onInboundError(err: unknown): void {
    if (!(err instanceof DecryptError)) throw err;
    // Data we can't decrypt with this name: never edit on top of it.
    this.halted = true;
    this.stopHeartbeat();
    clearTimeout(this.retryTimer);
    const s = this.socket;
    this.socket = null;
    s?.close();
    this.set({ status: { kind: "unreadable" } });
  }

  /**
   * Adds a server snapshot's content to the visible text as ops (nothing is replaced, so text that
   * is only here, not in `history`, survives). Returns a replica of exactly the snapshot.
   */
  private async mergeSnapshot(s: { upTo: number } & SealedWire): Promise<Rga> {
    const keys = this.keys!;
    const payload = await unseal<SnapshotPayload>(keys.key, keys.id, "snapshot", s);
    const ops = opsFromState(payload.state);
    if (this.composing) this.held.push(...ops);
    else this.applyRemote(ops);
    this.lastSnapshotUpTo = Math.max(this.lastSnapshotUpTo, s.upTo);
    return Rga.fromState(this.replica, payload.state);
  }

  private async loadSnapshot(s: { upTo: number } & SealedWire): Promise<void> {
    const keys = this.keys!;
    const payload = await unseal<SnapshotPayload>(keys.key, keys.id, "snapshot", s);
    const next = Rga.fromState(this.replica, payload.state);
    for (const op of this.history) next.apply(op); // keep anything applied here before the snapshot arrived
    const sel = this.snapshot.selection;
    this.rga = next;
    this.rebased = true; // from now on the visible CRDT holds content that `history` doesn't
    this.undoer = new UndoManager(next, 500); // undo history doesn't survive a re-base onto a snapshot
    this.setText({ selection: this.clampSelection(sel) });
  }

  /**
   * Phase 1 → live: an empty live note with a legacy blob is imported with deterministic ids (two
   * simultaneous importers produce identical ops). Text a Phase 1 tab typed but never saved
   * (pending:<id>) is merged on top, by import ids, then the entry is removed.
   */
  private async importLegacy(seq: number): Promise<void> {
    const keys = this.keys!;
    const pending = this.deps.legacyPending.load(keys.id);
    const needImport = seq === 0 && !this.welcomeHadSnapshot && this.rga.length === 0 && this.history.length === 0;
    if (!needImport && !pending) return;

    let remote;
    try {
      remote = await this.deps.api.getNote(keys.id);
    } catch {
      this.legacyChecked = false; // offline / server hiccup: try again on the next sync
      return;
    }
    // An undecryptable legacy blob throws DecryptError → the note is shown as unreadable.
    const legacyText = remote ? await decryptNote(keys.key, keys.id, remote) : "";

    if (needImport) {
      for (const op of importOps(legacyText)) {
        this.rga.apply(op);
        this.local(op);
      }
    }
    if (pending) {
      try {
        const pendingText = await decryptNote(keys.key, keys.id, pending.encrypted);
        for (const op of legacySpliceOps(legacyText, pendingText, this.rga)) this.local(op);
      } catch (err) {
        if (!(err instanceof DecryptError) && !(err instanceof RangeError)) throw err;
        // Not decryptable, or its base isn't in this note: nothing safe to merge.
      }
      this.deps.legacyPending.clear(keys.id);
    }
    this.setText({});
  }

  /** Our own unacked batches (this tab's, or a previous tab's in the same browser) must show here too. */
  private async replayOutbox(): Promise<void> {
    const keys = this.keys!;
    for (const item of this.deps.outbox.list(keys.id)) {
      try {
        const payload = await unseal<OpsPayload>(keys.key, keys.id, "ops", item);
        this.applyRemote(payload.ops);
      } catch {
        this.deps.outbox.remove(keys.id, item.cid); // not decryptable with this note's key: useless
      }
    }
  }

  private markReceived(seq: number): void {
    if (seq <= this.have) return;
    this.above.add(seq);
    this.absorb();
  }

  private absorb(): void {
    for (const s of this.above) if (s <= this.have) this.above.delete(s);
    while (this.above.delete(this.have + 1)) this.have++;
    for (const seq of this.haveIvs.keys()) if (seq < this.have) this.haveIvs.delete(seq); // only `have` and above matter
  }

  /**
   * After a reset catch-up: the visible text now holds everything the server sent. Re-send what the
   * server still lacks (its history was lost), in the usual batches. Other tabs repairing the same
   * note may send some of it too; the CRDT ignores the duplicates.
   */
  private finishRepair(): void {
    const server = this.repair;
    this.repair = null;
    this.repairPending = false;
    if (!server) return;
    const missing = opsServerLacks(this.rga, server);
    if (missing.length === 0) return;
    this.queued = [...missing, ...this.queued]; // lost history first: later edits may anchor on it
    void this.flush();
  }

  /** Applies remote ops; the local selection stays on the same characters (anchors, not indices). */
  private applyRemote(ops: Op[]): void {
    const sel = this.clampSelection(this.snapshot.selection);
    const startAnchor = toAnchor(this.rga, sel.start);
    const endAnchor = toAnchor(this.rga, sel.end);
    let changed = false;
    for (const op of ops) {
      this.history.push(op);
      if (this.rga.apply(op)) changed = true;
    }
    if (!changed) return;
    this.setText({ selection: { start: fromAnchor(this.rga, startAnchor), end: fromAnchor(this.rga, endAnchor) } });
  }

  /** Remote cursors as indices, recomputed whenever the text changes. Unknown anchors wait. */
  private computeCursors(): LiveSnapshot["cursors"] {
    const out: LiveSnapshot["cursors"] = [];
    for (const [from, p] of this.remote) {
      try {
        out.push({ from, color: p.color, start: fromAnchor(this.rga, p.anchor), end: fromAnchor(this.rga, p.head) });
      } catch {
        // Anchored on a character we haven't received yet; it shows up once that op arrives.
      }
    }
    return out;
  }

  private schedulePresence(): void {
    if (this.presenceTimer !== undefined) {
      this.presenceDue = true;
      return;
    }
    this.sendPresence();
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = undefined;
      if (this.presenceDue) {
        this.presenceDue = false;
        this.schedulePresence();
      }
    }, this.deps.presenceMs ?? 50);
  }

  private sendPresence(): void {
    const keys = this.keys;
    if (!keys || !this.open || this.snapshot.status.kind !== "ready") return;
    const sel = this.clampSelection(this.snapshot.selection);
    const payload: PresencePayload = {
      v: 1,
      r: this.replica,
      color: this.color,
      anchor: toAnchor(this.rga, sel.start),
      head: toAnchor(this.rga, sel.end),
    };
    this.presenceOut = this.presenceOut.then(async () => {
      const sealed = await seal(keys.key, keys.id, "presence", payload);
      if (this.open && !this.disposed) this.send({ t: "presence", ...sealed });
    });
  }

  /** Upload a snapshot, but only of state everyone already has (nothing of mine unacked, no gaps). */
  private maybeSnapshot(): void {
    const keys = this.keys;
    if (!keys || !this.open || this.composing || this.held.length > 0 || this.repair) return;
    if (this.have - this.lastSnapshotUpTo < (this.deps.snapshotEvery ?? 500)) return;
    if (this.queued.length > 0 || this.sealing > 0 || this.above.size > 0) return;
    if (this.deps.outbox.list(keys.id).length > 0 || this.rga.pendingCount() > 0) return;
    const upTo = this.have;
    const payload: SnapshotPayload = { v: 1, state: this.rga.toState() };
    this.lastSnapshotUpTo = upTo;
    void seal(keys.key, keys.id, "snapshot", payload).then((sealed) => {
      if (this.open && !this.disposed) this.send({ t: "snapshot", upTo, ...sealed });
    });
  }

  private clampSelection(sel: { start: number; end: number }) {
    const max = this.rga.length;
    return { start: Math.min(sel.start, max), end: Math.min(sel.end, max) };
  }

  // ---- outbound ----

  private local(op: Op): void {
    this.history.push(op);
    this.queued.push(op);
    if (this.batchTimer === undefined) {
      this.batchTimer = setTimeout(() => {
        this.batchTimer = undefined;
        void this.flush();
      }, this.deps.batchMs ?? 50);
    }
    this.updateUnsent();
  }

  /** Seals queued ops into one batch, stores it in the outbox, and sends it if connected. */
  private flush(): Promise<void> {
    const keys = this.keys;
    if (!keys || this.queued.length === 0) return this.outgoing;
    const batches = intoBatches(this.queued); // a big paste or import becomes several frames
    this.queued = [];
    this.sealing++;
    this.outgoing = this.outgoing.then(async () => {
      for (const ops of batches) {
        const payload: OpsPayload = { v: 1, at: (this.deps.now ?? Date.now)(), r: this.replica, color: this.color, ops };
        const sealed = await seal(keys.key, keys.id, "ops", payload);
        const cid = `${this.replica}-${++this.cidCounter}`;
        this.deps.outbox.add(keys.id, { cid, ...sealed }); // persisted before sending, even after dispose
        if (this.socket && this.open && !this.disposed) this.send({ t: "ops", cid, ...sealed });
      }
      this.sealing--;
      this.updateUnsent();
    });
    return this.outgoing;
  }

  private updateUnsent(): void {
    if (!this.keys) return;
    const unsent = this.deps.outbox.list(this.keys.id).length + (this.queued.length > 0 ? 1 : 0);
    if (unsent !== this.snapshot.unsent) this.set({ unsent });
  }

  /** Publishes the CRDT's text, with cursors recomputed against it. */
  private setText(patch: Partial<LiveSnapshot>): void {
    this.set({ ...patch, text: this.rga.text(), cursors: this.computeCursors() });
  }

  private set(patch: Partial<LiveSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }; // new object → React sees the change
    for (const listener of this.listeners) listener();
  }
}
