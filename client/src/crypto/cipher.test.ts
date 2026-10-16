import { beforeAll, describe, expect, it } from "vitest";
import { DecryptError, decryptNote, encryptNote } from "./cipher";

const ID = "a".repeat(43);
let key: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  const gen = () =>
    crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  key = await gen();
  otherKey = await gen();
});

describe("encryptNote / decryptNote", () => {
  it.each(["hello", "", "émoji 🌮 and\nnewlines"])("round-trips %j", async (text) => {
    const enc = await encryptNote(key, ID, text);
    expect(await decryptNote(key, ID, enc)).toBe(text);
  });

  it("uses a fresh 12-byte IV every time", async () => {
    const a = await encryptNote(key, ID, "same");
    const b = await encryptNote(key, ID, "same");
    expect(a.iv).toHaveLength(12);
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it("encrypts an empty note to at least 16 bytes (the server minimum)", async () => {
    const enc = await encryptNote(key, ID, "");
    expect(enc.ciphertext.length).toBeGreaterThanOrEqual(16);
  });

  it("rejects a tampered ciphertext", async () => {
    const enc = await encryptNote(key, ID, "secret");
    enc.ciphertext[0] ^= 1;
    await expect(decryptNote(key, ID, enc)).rejects.toBeInstanceOf(DecryptError);
  });

  it("rejects a different IV", async () => {
    const enc = await encryptNote(key, ID, "secret");
    enc.iv[0] ^= 1;
    await expect(decryptNote(key, ID, enc)).rejects.toBeInstanceOf(DecryptError);
  });

  it("rejects a blob moved to another note id (AAD binding)", async () => {
    const enc = await encryptNote(key, ID, "secret");
    await expect(decryptNote(key, "b".repeat(43), enc)).rejects.toBeInstanceOf(DecryptError);
  });

  it("rejects the wrong key", async () => {
    const enc = await encryptNote(key, ID, "secret");
    await expect(decryptNote(otherKey, ID, enc)).rejects.toBeInstanceOf(DecryptError);
  });

  it("rejects a payload that decrypts but is not our format", async () => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(ID) },
      key,
      new TextEncoder().encode('{"v":2,"text":"future"}'),
    );
    await expect(decryptNote(key, ID, { iv, ciphertext: new Uint8Array(ct) })).rejects.toBeInstanceOf(
      DecryptError,
    );
  });
});
