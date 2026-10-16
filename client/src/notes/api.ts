import type { EncryptedNote } from "../crypto/cipher";
import { fromBase64, toBase64 } from "../crypto/encoding";

export interface RemoteNote extends EncryptedNote {
  version: number;
  updatedAt: number;
}

export interface SaveResult {
  version: number;
  updatedAt: number;
}

export interface NotesApi {
  getNote(id: string): Promise<RemoteNote | null>;
  putNote(id: string, encrypted: EncryptedNote, baseVersion: number): Promise<SaveResult>;
}

export class NetworkError extends Error {
  constructor() {
    super("network request failed");
    this.name = "NetworkError";
  }
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`server responded ${status}`);
    this.name = "HttpError";
    this.status = status;
  }
}

export class ConflictError extends Error {
  readonly currentVersion: number;
  constructor(currentVersion: number) {
    super(`version conflict (server is at ${currentVersion})`);
    this.name = "ConflictError";
    this.currentVersion = currentVersion;
  }
}

export class TooLargeError extends Error {
  constructor() {
    super("note too large");
    this.name = "TooLargeError";
  }
}

/** Worth trying again later: the network or the server hiccupped, not our request. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof NetworkError) return true;
  if (!(err instanceof HttpError)) return false;
  return err.status >= 500 || err.status === 408 || err.status === 429; // timeout / rate limit: try later
}

/** Same limit the server enforces (httpapi.maxBodyBytes). */
export const MAX_BODY_BYTES = 1 << 20;

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

interface NoteBody {
  ciphertext: string;
  iv: string;
  version: number;
  updated_at: number;
}

export function createNotesApi(
  fetchFn: FetchFn = (input, init) => fetch(input, init),
  baseUrl = "/api",
): NotesApi {
  async function send(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetchFn(`${baseUrl}${path}`, init);
    } catch {
      throw new NetworkError(); // fetch only rejects when no HTTP response arrived at all
    }
  }

  return {
    async getNote(id) {
      const res = await send(`/notes/${id}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new HttpError(res.status);
      const body = (await res.json()) as NoteBody;
      return {
        ciphertext: fromBase64(body.ciphertext),
        iv: fromBase64(body.iv),
        version: body.version,
        updatedAt: body.updated_at,
      };
    },

    async putNote(id, encrypted, baseVersion) {
      const payload = JSON.stringify({
        ciphertext: toBase64(encrypted.ciphertext),
        iv: toBase64(encrypted.iv),
        base_version: baseVersion,
      });
      // The server would answer 413 anyway; don't upload a megabyte to hear it.
      // (The body is ASCII, so string length = bytes.)
      if (payload.length > MAX_BODY_BYTES) throw new TooLargeError();
      const res = await send(`/notes/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      if (res.status === 409) {
        const body = (await res.json()) as { current_version: number };
        throw new ConflictError(body.current_version);
      }
      if (res.status === 413) throw new TooLargeError();
      if (!res.ok) throw new HttpError(res.status);
      const body = (await res.json()) as { version: number; updated_at: number };
      return { version: body.version, updatedAt: body.updated_at };
    },
  };
}
