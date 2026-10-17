import { describe, expect, it } from "vitest";
import { argon2Master, deriveNoteKeys, keysFromMaster } from "./derive";
import { deriveNoteKeysInWorker } from "./deriveInWorker";

describe("split derivation", () => {
  it("argon2Master + keysFromMaster equals deriveNoteKeys", async () => {
    const viaSplit = await keysFromMaster(await argon2Master("taco"));
    expect(viaSplit.id).toBe((await deriveNoteKeys("taco")).id);
    expect(viaSplit.id).toBe("DqMCETSlWMyiBEuz-TOWLYfWY4EYFz8GGBMm0p3Xl1M");
  });

  it("falls back to the main thread where Worker does not exist (Node), same answer", async () => {
    expect(typeof Worker).toBe("undefined");
    expect((await deriveNoteKeysInWorker("taco")).id).toBe("DqMCETSlWMyiBEuz-TOWLYfWY4EYFz8GGBMm0p3Xl1M");
  });
});
