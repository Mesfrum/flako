import { utf8 } from "./encoding";

export interface EncryptedNote {
  ciphertext: Uint8Array;
  iv: Uint8Array;
}

/** Any failure to turn ciphertext back into a note: wrong key, tampering, unknown format. */
export class DecryptError extends Error {
  constructor(message = "note could not be decrypted") {
    super(message);
    this.name = "DecryptError";
  }
}

interface PlaintextV1 {
  v: 1;
  text: string;
}

const decoder = new TextDecoder();

export async function encryptNote(key: CryptoKey, noteId: string, text: string): Promise<EncryptedNote> {
  // NEVER reuse an IV with the same key. Random 96-bit IVs are safe for far more saves than we'll ever do.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload: PlaintextV1 = { v: 1, text };
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8(noteId) },
    key,
    utf8(JSON.stringify(payload)),
  );
  return { ciphertext: new Uint8Array(ciphertext), iv };
}

export async function decryptNote(key: CryptoKey, noteId: string, enc: EncryptedNote): Promise<string> {
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: enc.iv, additionalData: utf8(noteId) },
      key,
      enc.ciphertext,
    );
  } catch {
    throw new DecryptError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(plain));
  } catch {
    throw new DecryptError("note payload is not valid JSON");
  }
  if (!isPlaintextV1(parsed)) throw new DecryptError("unsupported note format");
  return parsed.text;
}

function isPlaintextV1(v: unknown): v is PlaintextV1 {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { v?: unknown }).v === 1 &&
    typeof (v as { text?: unknown }).text === "string"
  );
}
