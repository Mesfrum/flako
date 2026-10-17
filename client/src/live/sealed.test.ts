import { beforeAll, expect, it } from "vitest";
import { DecryptError } from "../crypto/cipher";
import { seal, unseal } from "./sealed";

const ID = "a".repeat(43);
let key: CryptoKey;

beforeAll(async () => {
  key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
});

it("round-trips a payload", async () => {
  const s = await seal(key, ID, "ops", { v: 1, hello: "🌮" });
  expect(await unseal(key, ID, "ops", s)).toEqual({ v: 1, hello: "🌮" });
});

it("a presence message cannot be opened as ops (kind in AAD)", async () => {
  const s = await seal(key, ID, "presence", { v: 1 });
  await expect(unseal(key, ID, "ops", s)).rejects.toBeInstanceOf(DecryptError);
});

it("a message for another note fails", async () => {
  const s = await seal(key, ID, "ops", {});
  await expect(unseal(key, "b".repeat(43), "ops", s)).rejects.toBeInstanceOf(DecryptError);
});

it("fresh IV every time", async () => {
  expect((await seal(key, ID, "ops", 1)).iv).not.toBe((await seal(key, ID, "ops", 1)).iv);
});

it("garbage base64 or ciphertext is a DecryptError, not a crash", async () => {
  await expect(unseal(key, ID, "ops", { ct: "!!!", iv: "!!!" })).rejects.toBeInstanceOf(DecryptError);
  await expect(unseal(key, ID, "ops", { ct: "AAAA", iv: "AAAAAAAAAAAAAAAA" })).rejects.toBeInstanceOf(DecryptError);
});
