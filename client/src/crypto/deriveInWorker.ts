import { deriveNoteKeys, keysFromMaster, type NoteKeys } from "./derive";
import type { DeriveReply, DeriveRequest } from "./derive.worker";

let worker: Worker | null = null;
let nextId = 0;
const waiting = new Map<number, { resolve: (m: Uint8Array) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./derive.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<DeriveReply>) => {
    const entry = waiting.get(e.data.id);
    if (!entry) return;
    waiting.delete(e.data.id);
    if ("master" in e.data) entry.resolve(e.data.master);
    else entry.reject(new Error(e.data.error));
  };
  worker.onerror = () => {
    // A broken worker fails everything in flight; callers fall back to the main thread.
    for (const entry of waiting.values()) entry.reject(new Error("derive worker failed"));
    waiting.clear();
    worker = null;
  };
  return worker;
}

/** Same result as deriveNoteKeys, but Argon2 runs in a Web Worker when one is available. */
export async function deriveNoteKeysInWorker(normalizedName: string): Promise<NoteKeys> {
  if (typeof Worker === "undefined") return deriveNoteKeys(normalizedName);
  try {
    const master = await new Promise<Uint8Array>((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      const request: DeriveRequest = { id, name: normalizedName };
      getWorker().postMessage(request);
    });
    return await keysFromMaster(master);
  } catch {
    return deriveNoteKeys(normalizedName);
  }
}
