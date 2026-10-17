import { DecryptError } from "../crypto/cipher";
import type { NoteKeys } from "../crypto/derive";
import type { NotesApi } from "../notes/api";
import type { PendingStore } from "../notes/pending";
import { Rga, type Op } from "./crdt/rga";
import { fromAnchor, spliceFromChange, toAnchor } from "./editing";
import type { Outbox } from "./outbox";
import { CLOSE_ROOM_FULL, type ClientMsg, type OpsPayload, type SealedWire, type ServerMsg, type SnapshotPayload } from "./protocol";
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
export const CURSOR_COLORS = ["#e4572e", "#29335c", "#f3a712", "#669bbc", "#a8c686", "#b56576", "#6d597a", "#2a9d8f"];

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

  constructor(name: string, deps: LiveNoteDeps) {
    this.name = name;
    this.deps = deps;
    this.replica = deps.replica ?? randomReplica();
    this.color = CURSOR_COLORS[Math.floor(Math.random() * CURSOR_COLORS.length)];
    this.rga = new Rga(this.replica);
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
    const s = this.socket;
    this.socket = null;
    this.open = false;
    s?.close();
  }

  /** The textarea now holds `next`; selection is where the browser put the caret. */
  change = (next: string, selStart: number, selEnd: number): void => {
    if (this.snapshot.status.kind !== "ready") return;
    const splice = spliceFromChange(this.rga.text(), next, selEnd);
    if (splice) {
      if (splice.remove > 0) {
        const op = this.rga.delete(splice.index, splice.remove);
        if (op) this.local(op);
      }
      if (splice.insert.length > 0) this.local(this.rga.insert(splice.index, splice.insert));
    }
    this.set({ text: this.rga.text(), selection: { start: selStart, end: selEnd } });
  };

  select = (start: number, end: number): void => {
    this.set({ selection: { start, end } });
  };

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
        this.send({ t: "hello", have: this.have });
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
        if (m.snapshot) await this.loadSnapshot(m.snapshot);
        return;
      case "op": {
        const payload = await unseal<OpsPayload>(keys.key, keys.id, "ops", m);
        this.applyRemote(payload.ops);
        this.markReceived(m.seq);
        return;
      }
      case "ack":
        this.deps.outbox.remove(keys.id, m.cid);
        this.markReceived(m.seq);
        this.updateUnsent();
        return;
      case "synced":
        this.have = Math.max(this.have, m.seq);
        this.absorb();
        await this.replayOutbox();
        this.retryDelay = FIRST_RETRY_MS;
        this.set({ status: { kind: "ready" }, conn: "live" });
        this.updateUnsent();
        return;
      case "here":
        this.set({ here: m.n });
        return;
      case "pong":
        clearTimeout(this.pongTimer);
        this.pongTimer = undefined;
        return;
      case "presence":
      case "left":
        return; // Task 11
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

  private async loadSnapshot(s: { upTo: number } & SealedWire): Promise<void> {
    const keys = this.keys!;
    const payload = await unseal<SnapshotPayload>(keys.key, keys.id, "snapshot", s);
    const next = Rga.fromState(this.replica, payload.state);
    for (const op of this.history) next.apply(op); // keep anything applied here before the snapshot arrived
    const sel = this.snapshot.selection;
    this.rga = next;
    this.set({ text: next.text(), selection: this.clampSelection(sel) });
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
    this.set({
      text: this.rga.text(),
      selection: { start: fromAnchor(this.rga, startAnchor), end: fromAnchor(this.rga, endAnchor) },
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
    const ops = this.queued;
    this.queued = [];
    this.outgoing = this.outgoing.then(async () => {
      const payload: OpsPayload = { v: 1, at: (this.deps.now ?? Date.now)(), r: this.replica, color: this.color, ops };
      const sealed = await seal(keys.key, keys.id, "ops", payload);
      const cid = `${this.replica}-${++this.cidCounter}`;
      this.deps.outbox.add(keys.id, { cid, ...sealed }); // persisted before sending, even after dispose
      if (this.socket && this.open && !this.disposed) this.send({ t: "ops", cid, ...sealed });
      this.updateUnsent();
    });
    return this.outgoing;
  }

  private updateUnsent(): void {
    if (!this.keys) return;
    const unsent = this.deps.outbox.list(this.keys.id).length + (this.queued.length > 0 ? 1 : 0);
    if (unsent !== this.snapshot.unsent) this.set({ unsent });
  }

  private set(patch: Partial<LiveSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }; // new object → React sees the change
    for (const listener of this.listeners) listener();
  }
}
