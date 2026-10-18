// Wire protocol between LiveNote and the Go hub (server/internal/live/messages.go mirrors it).
// The OUTSIDE (t, seq, cid, upTo, from, n) is visible to the server; ct/iv are sealed payloads.
import type { Op, RgaState } from "./crdt/rga";
import type { Anchor } from "./editing";

/** A sealed payload: standard base64 ciphertext and 12-byte IV. */
export interface SealedWire {
  ct: string;
  iv: string;
}

export type ClientMsg =
  | { t: "hello"; have: number; haveIv?: string } // haveIv: IV of the op at `have`; lets the server spot a rewound log
  | ({ t: "ops"; cid: string } & SealedWire)
  | ({ t: "presence" } & SealedWire)
  | ({ t: "snapshot"; upTo: number } & SealedWire)
  | { t: "ping" };

export type ServerMsg =
  | {
      t: "welcome";
      seq: number;
      here: number;
      snapshot: ({ upTo: number } & SealedWire) | null;
      reset: boolean; // the server's log is not the one this client knew: it caught us up from zero
      seqIv: string; // IV of the server's op at `seq` ("" when seq is 0)
    }
  | ({ t: "op"; seq: number } & SealedWire)
  | { t: "ack"; cid: string; seq: number }
  | { t: "synced"; seq: number }
  | ({ t: "presence"; from: number } & SealedWire)
  | { t: "left"; from: number }
  | { t: "here"; n: number }
  | { t: "pong" };

/** Inside an "ops" message. `at`, `r` and `color` are kept for Phase 3 history. */
export interface OpsPayload {
  v: 1;
  at: number; // client time, unix ms
  r: string; // sender's per-visit replica id
  color: string;
  ops: Op[];
}

/** Inside a "presence" message: where my selection is, as anchors. */
export interface PresencePayload {
  v: 1;
  r: string;
  color: string;
  anchor: Anchor; // selection start
  head: Anchor; // selection end
}

export interface SnapshotPayload {
  v: 1;
  state: RgaState;
}

export const CLOSE_ROOM_FULL = 4001;
export const CLOSE_BAD_MESSAGE = 4400;
export const CLOSE_TOO_SLOW = 4008;
