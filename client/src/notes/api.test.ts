import { describe, expect, it } from "vitest";
import { toBase64 } from "../crypto/encoding";
import { createNotesApi, NetworkError, type FetchFn } from "./api";

const ID = "a".repeat(43);
const enc = { ciphertext: new Uint8Array(16).fill(1), iv: new Uint8Array(12).fill(2) };

function fakeFetch(respond: () => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { fn, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("getNote", () => {
  it("decodes a stored note", async () => {
    const { fn, calls } = fakeFetch(() =>
      json(200, { ciphertext: toBase64(enc.ciphertext), iv: toBase64(enc.iv), version: 3, updated_at: 99 }),
    );
    const note = await createNotesApi(fn).getNote(ID);
    expect(calls[0].url).toBe(`/api/notes/${ID}`);
    expect(note).toEqual({ ...enc, version: 3, updatedAt: 99 });
  });

  it("returns null for 404", async () => {
    const { fn } = fakeFetch(() => json(404, { error: "note not found" }));
    expect(await createNotesApi(fn).getNote(ID)).toBeNull();
  });

  it("throws HttpError for 500", async () => {
    const { fn } = fakeFetch(() => json(500, { error: "internal error" }));
    await expect(createNotesApi(fn).getNote(ID)).rejects.toMatchObject({ status: 500 });
  });
});

it("maps a thrown fetch to NetworkError", async () => {
  const fn: FetchFn = async () => {
    throw new TypeError("Failed to fetch");
  };
  await expect(createNotesApi(fn).getNote(ID)).rejects.toBeInstanceOf(NetworkError);
});
