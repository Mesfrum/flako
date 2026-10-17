import type { KeyValueStorage } from "../notes/pending";

/** One sealed edit batch waiting for the server's ack. Ciphertext only — never plaintext. */
export interface OutboxItem {
  cid: string;
  ct: string;
  iv: string;
}

export interface Outbox {
  list(noteId: string): OutboxItem[];
  add(noteId: string, item: OutboxItem): void;
  remove(noteId: string, cid: string): void;
}

const keyFor = (noteId: string) => `outbox:${noteId}`;

export function createOutbox(storage: KeyValueStorage): Outbox {
  const read = (noteId: string): OutboxItem[] => {
    const raw = storage.getItem(keyFor(noteId));
    if (!raw) return [];
    try {
      const items = JSON.parse(raw) as unknown;
      if (!Array.isArray(items)) return [];
      return items.filter(
        (i): i is OutboxItem =>
          typeof i === "object" && i !== null && typeof i.cid === "string" && typeof i.ct === "string" && typeof i.iv === "string",
      );
    } catch {
      return [];
    }
  };
  const write = (noteId: string, items: OutboxItem[]) => {
    try {
      if (items.length === 0) storage.removeItem(keyFor(noteId));
      else storage.setItem(keyFor(noteId), JSON.stringify(items.map(({ cid, ct, iv }) => ({ cid, ct, iv }))));
    } catch {
      // Quota exceeded or storage disabled: the "offline — will sync" status already warns the user.
    }
  };
  return {
    list: read,
    add(noteId, item) {
      const items = read(noteId);
      if (!items.some((i) => i.cid === item.cid)) items.push(item);
      write(noteId, items);
    },
    remove(noteId, cid) {
      write(noteId, read(noteId).filter((i) => i.cid !== cid));
    },
  };
}
