import type { EncryptedNote } from "../crypto/cipher";
import { fromBase64, toBase64 } from "../crypto/encoding";

/** A save that has not reached the server yet. Ciphertext only — never plaintext. */
export interface PendingSave {
  encrypted: EncryptedNote;
  baseVersion: number;
}

export interface PendingStore {
  load(id: string): PendingSave | null;
  save(id: string, pending: PendingSave): void;
  /** Removes the entry; with `iv`, only if the stored entry is that exact ciphertext. */
  clear(id: string, iv?: Uint8Array): void;
}

export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

interface StoredPending {
  ciphertext: string;
  iv: string;
  baseVersion: number;
}

const keyFor = (id: string) => `pending:${id}`;

export function createPendingStore(storage: KeyValueStorage): PendingStore {
  return {
    load(id) {
      const raw = storage.getItem(keyFor(id));
      if (!raw) return null;
      try {
        const p = JSON.parse(raw) as Partial<StoredPending>;
        if (typeof p.ciphertext !== "string" || typeof p.iv !== "string" || typeof p.baseVersion !== "number") {
          return null;
        }
        return {
          encrypted: { ciphertext: fromBase64(p.ciphertext), iv: fromBase64(p.iv) },
          baseVersion: p.baseVersion,
        };
      } catch {
        return null;
      }
    },

    save(id, pending) {
      const stored: StoredPending = {
        ciphertext: toBase64(pending.encrypted.ciphertext),
        iv: toBase64(pending.encrypted.iv),
        baseVersion: pending.baseVersion,
      };
      try {
        storage.setItem(keyFor(id), JSON.stringify(stored));
      } catch {
        // Quota exceeded or storage disabled: the "unsaved" status already warns the user.
      }
    },

    clear(id, iv) {
      if (iv) {
        const raw = storage.getItem(keyFor(id));
        try {
          if (!raw || (JSON.parse(raw) as Partial<StoredPending>).iv !== toBase64(iv)) return;
        } catch {
          return;
        }
      }
      storage.removeItem(keyFor(id));
    },
  };
}

/** In-memory Storage stand-in for tests (and environments without localStorage). */
export function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}
