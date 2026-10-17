import { argon2id } from "hash-wasm";
import { toBase64Url, utf8 } from "./encoding";

/**
 * Frozen forever: changing ANY of these makes every existing note unreadable.
 * The salt is app-wide (it must be — two people typing the same name need the
 * same key), so security rests on Argon2's cost and on the name's strength.
 */
export const KDF_PARAMS = {
  salt: "flako/v1",
  memorySize: 65536, // KiB = 64 MiB
  iterations: 3,
  parallelism: 1,
  hashLength: 32,
} as const;

export interface NoteKeys {
  /** base64url(HKDF(master, "id")) — the only thing the server ever sees. */
  id: string;
  /** AES-256-GCM key; non-extractable, never leaves this browser tab. */
  key: CryptoKey;
}

/** Expects an already-normalized name (see names/normalizeName). Takes ~0.5s on purpose. */
export async function deriveNoteKeys(normalizedName: string): Promise<NoteKeys> {
  return keysFromMaster(await argon2Master(normalizedName));
}

/** The slow, memory-hard half (~0.5s, 64 MiB). Safe to run in a Web Worker. */
export async function argon2Master(normalizedName: string): Promise<Uint8Array> {
  return argon2id({
    password: normalizedName,
    salt: KDF_PARAMS.salt,
    memorySize: KDF_PARAMS.memorySize,
    iterations: KDF_PARAMS.iterations,
    parallelism: KDF_PARAMS.parallelism,
    hashLength: KDF_PARAMS.hashLength,
    outputType: "binary",
  });
}

/** The fast half: HKDF into the note id and a non-extractable AES key (main thread). */
export async function keysFromMaster(master: Uint8Array): Promise<NoteKeys> {
  const hkdfKey = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveBits", "deriveKey"]);
  const hkdf = (info: string): HkdfParams => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(0),
    info: utf8(info),
  });

  const idBits = await crypto.subtle.deriveBits(hkdf("flako/v1/id"), hkdfKey, 256);
  const key = await crypto.subtle.deriveKey(
    hkdf("flako/v1/enc"),
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  return { id: toBase64Url(new Uint8Array(idBits)), key };
}
