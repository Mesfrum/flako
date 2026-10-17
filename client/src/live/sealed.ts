import { DecryptError } from "../crypto/cipher";
import { fromBase64, toBase64, utf8 } from "../crypto/encoding";
import type { SealedWire } from "./protocol";

export type SealKind = "ops" | "presence" | "snapshot";

const decoder = new TextDecoder();

// AAD binds both the note and the kind: a cursor message can't be replayed as an edit.
const aad = (noteId: string, kind: SealKind) => utf8(`${noteId}|${kind}`);

export async function seal(key: CryptoKey, noteId: string, kind: SealKind, value: unknown): Promise<SealedWire> {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // never reuse an IV under one key
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(noteId, kind) },
    key,
    utf8(JSON.stringify(value)),
  );
  return { ct: toBase64(new Uint8Array(ct)), iv: toBase64(iv) };
}

/** Any failure (bad base64, wrong key/note/kind, tampering, bad JSON) is a DecryptError. */
export async function unseal<T>(key: CryptoKey, noteId: string, kind: SealKind, s: SealedWire): Promise<T> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(s.iv), additionalData: aad(noteId, kind) },
      key,
      fromBase64(s.ct),
    );
    return JSON.parse(decoder.decode(plain)) as T;
  } catch {
    throw new DecryptError();
  }
}
