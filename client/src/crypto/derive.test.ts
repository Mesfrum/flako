import { describe, expect, it } from "vitest";
import { decryptNote, DecryptError, encryptNote } from "./cipher";
import { deriveNoteKeys, KDF_PARAMS } from "./derive";

describe("deriveNoteKeys", () => {
  it("pins the KDF parameters — changing them orphans every existing note", () => {
    expect(KDF_PARAMS).toEqual({
      salt: "flako/v1",
      memorySize: 65536,
      iterations: 3,
      parallelism: 1,
      hashLength: 32,
    });
  });

  it("matches known answers (computed once, frozen forever)", async () => {
    expect((await deriveNoteKeys("taco")).id).toBe("DqMCETSlWMyiBEuz-TOWLYfWY4EYFz8GGBMm0p3Xl1M");
    expect((await deriveNoteKeys("velvet-anchor-mutters-softly")).id).toBe(
      "hwzWX5YnQyJukfK1YDpSa7y3DJZUqq5E8AdjYFThQ-o",
    );
  });

  it("derives the same id and a compatible key for the same name", async () => {
    const a = await deriveNoteKeys("same-name");
    const b = await deriveNoteKeys("same-name");
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const enc = await encryptNote(a.key, a.id, "hi");
    expect(await decryptNote(b.key, b.id, enc)).toBe("hi");
  });

  it("derives unrelated keys for different names", async () => {
    const a = await deriveNoteKeys("name-one");
    const b = await deriveNoteKeys("name-two");
    expect(a.id).not.toBe(b.id);
    const enc = await encryptNote(a.key, a.id, "hi");
    await expect(decryptNote(b.key, a.id, enc)).rejects.toBeInstanceOf(DecryptError);
  });

  it("produces a non-extractable key", async () => {
    const { key } = await deriveNoteKeys("taco");
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });
});
