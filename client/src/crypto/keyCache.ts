import type { NoteKeys } from "./derive";
import { deriveNoteKeysInWorker } from "./deriveInWorker";

type Derive = (normalizedName: string) => Promise<NoteKeys>;

/**
 * Remembers the keys for the most recent name only, in memory (never in browser storage).
 * Home prefetches while the name is typed so opening the note skips the Argon2 wait.
 * One prefetch runs at a time: names typed past while it runs are skipped, so a fast typist
 * never queues a pile of 64 MiB derivations in the worker.
 */
export function createKeyCache(derive: Derive) {
  let latest: { name: string; keys: Promise<NoteKeys> } | null = null;
  let running = false;
  let wanted: string | null = null;

  const start = (name: string) => {
    const keys = derive(name);
    latest = { name, keys };
    // A failure must not stick: forget it so the next get derives again.
    keys.catch(() => {
      if (latest?.keys === keys) latest = null;
    });
    return keys;
  };

  const pump = async () => {
    running = true;
    while (wanted !== null && wanted !== latest?.name) {
      const name = wanted;
      wanted = null;
      await start(name).catch(() => undefined);
    }
    wanted = null;
    running = false;
  };

  return {
    prefetch(name: string): void {
      wanted = name;
      if (!running) void pump();
    },

    get(name: string): Promise<NoteKeys> {
      wanted = null; // the note is opening: a queued prefetch would only slow it down
      if (latest?.name === name) {
        const cached = latest.keys;
        return cached.catch(() => start(name));
      }
      return start(name);
    },
  };
}

export const noteKeys = createKeyCache(deriveNoteKeysInWorker);
