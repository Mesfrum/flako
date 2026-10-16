import { describe, expect, it } from "vitest";
import { toBase64 } from "../crypto/encoding";
import {
  ConflictError,
  createNotesApi,
  HttpError,
  isRetryable,
  NetworkError,
  TooLargeError,
  type FetchFn,
} from "./api";

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

describe("putNote", () => {
  it("sends base64 body with base_version and returns the new version", async () => {
    const { fn, calls } = fakeFetch(() => json(200, { version: 4, updated_at: 123 }));
    const res = await createNotesApi(fn).putNote(ID, enc, 3);
    expect(res).toEqual({ version: 4, updatedAt: 123 });
    expect(calls[0].init?.method).toBe("PUT");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      ciphertext: toBase64(enc.ciphertext),
      iv: toBase64(enc.iv),
      base_version: 3,
    });
  });

  it("maps 409 to ConflictError with the server's version", async () => {
    const { fn } = fakeFetch(() => json(409, { error: "version conflict", current_version: 7 }));
    const err = await createNotesApi(fn).putNote(ID, enc, 3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).currentVersion).toBe(7);
  });

  it("maps 413 to TooLargeError", async () => {
    const { fn } = fakeFetch(() => json(413, { error: "note too large" }));
    await expect(createNotesApi(fn).putNote(ID, enc, 0)).rejects.toBeInstanceOf(TooLargeError);
  });

  it("refuses a body over the server's 1 MiB limit without sending it", async () => {
    const { fn, calls } = fakeFetch(() => json(200, { version: 1, updated_at: 1 }));
    const huge = { ciphertext: new Uint8Array(800_000), iv: new Uint8Array(12) }; // ~1.07 MB as base64
    await expect(createNotesApi(fn).putNote(ID, huge, 0)).rejects.toBeInstanceOf(TooLargeError);
    expect(calls).toHaveLength(0);
  });

  it("maps a thrown fetch to NetworkError", async () => {
    const fn: FetchFn = async () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(createNotesApi(fn).putNote(ID, enc, 0)).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("isRetryable", () => {
  it("retries network errors and 5xx only", () => {
    expect(isRetryable(new NetworkError())).toBe(true);
    expect(isRetryable(new HttpError(503))).toBe(true);
    expect(isRetryable(new HttpError(400))).toBe(false);
    expect(isRetryable(new ConflictError(1))).toBe(false);
    expect(isRetryable(new TooLargeError())).toBe(false);
  });

  it("retries request-timeout and rate-limit responses (proxies send these)", () => {
    expect(isRetryable(new HttpError(408))).toBe(true);
    expect(isRetryable(new HttpError(429))).toBe(true);
  });
});
