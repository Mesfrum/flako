// Test-only in-memory stand-in for server/internal/live (same rules, no network, no crypto of its own).
import type { ClientMsg, ServerMsg } from "../protocol";
import type { Connect, Socket, SocketHandlers } from "../liveNote";

interface FakePeer {
  id: number;
  noteId: string;
  handlers: SocketHandlers;
  joined: boolean;
  closed: boolean;
}

export class FakeHub {
  /** false → connect() fails: onClose(1006) arrives asynchronously. */
  online = true;
  /** true → ops are stored and broadcast, but acks are withheld. */
  holdAcks = false;
  log: { seq: number; ct: string; iv: string }[] = [];
  snapshots: { upTo: number; ct: string; iv: string }[] = [];
  /** Every hello's `have`, in arrival order. */
  hellos: number[] = [];
  /** Every hello in full, and the `reset` flag of every welcome sent. */
  helloMsgs: { have: number; haveIv?: string }[] = [];
  welcomes: { reset: boolean; seq: number }[] = [];
  /** true → welcome and ops are sent but `synced` is not, so a test can cut the connection mid-catch-up. */
  withholdSynced = false;
  /**
   * Set → on the next hello, this sealed op is appended (seq = latest + 1) and broadcast BEFORE the
   * welcome (which still says seq = latest): the Go hub's writer can deliver a queued broadcast first.
   */
  injectBeforeWelcome: { ct: string; iv: string } | null = null;
  private silent = false;
  private nextId = 0;
  private live = new Set<FakePeer>();

  connect: Connect = (noteId, handlers) => {
    const peer: FakePeer = { id: ++this.nextId, noteId, handlers, joined: false, closed: false };
    if (!this.online) {
      later(() => handlers.onClose(1006));
      return { send: () => {}, close: () => {} };
    }
    this.live.add(peer);
    later(() => !peer.closed && handlers.onOpen());
    const socket: Socket = {
      send: (msg) => later(() => this.receive(peer, JSON.parse(JSON.stringify(msg)) as ClientMsg)),
      close: () => later(() => this.disconnect(peer, false)),
    };
    return socket;
  };

  /** Closes every socket as if the server restarted. */
  dropAll(): void {
    for (const p of [...this.live]) this.disconnect(p, true);
  }

  /** A restored backup: forget everything above `toSeq` (log and snapshots), and drop every socket. */
  rewind(toSeq: number): void {
    this.log = this.log.slice(0, toSeq);
    this.snapshots = this.snapshots.filter((s) => s.upTo <= toSeq);
    this.dropAll();
  }

  /** Stops replying to anyone (pong, acks, broadcasts) without closing: a dead socket. */
  silence(): void {
    this.silent = true;
  }

  resume(): void {
    this.silent = false;
  }

  peers(): number {
    return [...this.live].filter((p) => p.joined).length;
  }

  private receive(p: FakePeer, m: ClientMsg): void {
    if (p.closed || this.silent) return;
    if (!p.joined && m.t !== "hello") return this.disconnect(p, true, 4400);
    switch (m.t) {
      case "hello": {
        this.hellos.push(m.have);
        this.helloMsgs.push({ have: m.have, haveIv: m.haveIv });
        p.joined = true;
        const room = this.room(p.noteId);
        const latest = this.log.length;
        // Same rule as the Go hub: the IV of the op at `have` fingerprints the history. Missing or
        // different → the log was rewound/replaced, so catch up from zero and say so.
        let have = m.have;
        let reset = false;
        if (have > 0 && m.haveIv) {
          const mine = this.log[have - 1];
          if (!mine || mine.seq !== have || mine.iv !== m.haveIv) {
            reset = true;
            have = 0;
          }
        }
        if (this.injectBeforeWelcome) {
          const op = { seq: latest + 1, ...this.injectBeforeWelcome };
          this.injectBeforeWelcome = null;
          this.log.push(op);
          this.sendTo(p, { t: "op", ...op });
          this.broadcast(p, { t: "op", ...op });
        }
        this.welcomes.push({ reset, seq: latest });
        const snap = have === 0 ? this.snapshots[this.snapshots.length - 1] ?? null : null;
        const seqIv = latest > 0 ? this.log[latest - 1].iv : "";
        this.sendTo(p, { t: "welcome", seq: latest, here: room.length, snapshot: snap, reset, seqIv });
        const from = Math.max(have, snap?.upTo ?? 0);
        for (const op of this.log.slice(from, latest)) this.sendTo(p, { t: "op", ...op });
        if (!this.withholdSynced) this.sendTo(p, { t: "synced", seq: latest });
        this.broadcast(p, { t: "here", n: room.length });
        return;
      }
      case "ops": {
        const op = { seq: this.log.length + 1, ct: m.ct, iv: m.iv };
        this.log.push(op);
        if (!this.holdAcks) this.sendTo(p, { t: "ack", cid: m.cid, seq: op.seq });
        this.broadcast(p, { t: "op", ...op });
        return;
      }
      case "presence":
        return this.broadcast(p, { t: "presence", from: p.id, ct: m.ct, iv: m.iv });
      case "snapshot": {
        const last = this.snapshots[this.snapshots.length - 1];
        if (m.upTo <= this.log.length && (!last || m.upTo > last.upTo)) {
          this.snapshots.push({ upTo: m.upTo, ct: m.ct, iv: m.iv });
        }
        return;
      }
      case "ping":
        return this.sendTo(p, { t: "pong" });
    }
  }

  private room(noteId: string): FakePeer[] {
    return [...this.live].filter((p) => p.noteId === noteId && p.joined);
  }

  private sendTo(p: FakePeer, msg: ServerMsg): void {
    if (p.closed || this.silent) return;
    const wire = JSON.parse(JSON.stringify(msg)) as ServerMsg;
    later(() => !p.closed && p.handlers.onMessage(wire));
  }

  private broadcast(from: FakePeer, msg: ServerMsg): void {
    for (const p of this.room(from.noteId)) if (p !== from) this.sendTo(p, msg);
  }

  private disconnect(p: FakePeer, notify: boolean, code = 1006): void {
    if (p.closed) return;
    p.closed = true;
    this.live.delete(p);
    if (notify) later(() => p.handlers.onClose(code));
    if (p.joined) {
      for (const other of this.room(p.noteId)) {
        this.sendTo(other, { t: "left", from: p.id });
        this.sendTo(other, { t: "here", n: this.room(p.noteId).length });
      }
    }
  }
}

/** Async delivery that fake timers don't control (microtasks), like a real network callback. */
function later(fn: () => void): void {
  void Promise.resolve().then(fn);
}
