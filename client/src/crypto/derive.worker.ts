/// <reference lib="webworker" />
// Runs Argon2 off the main thread so the page stays responsive while a note opens.
import { argon2Master } from "./derive";

export interface DeriveRequest {
  id: number;
  name: string;
}
export type DeriveReply = { id: number; master: Uint8Array } | { id: number; error: string };

self.onmessage = async (e: MessageEvent<DeriveRequest>) => {
  const { id, name } = e.data;
  try {
    const master = await argon2Master(name);
    const reply: DeriveReply = { id, master };
    (self as DedicatedWorkerGlobalScope).postMessage(reply, [master.buffer]); // transfer, don't copy
  } catch (err) {
    const reply: DeriveReply = { id, error: String(err) };
    (self as DedicatedWorkerGlobalScope).postMessage(reply);
  }
};
