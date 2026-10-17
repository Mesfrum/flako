import type { EncryptedNote } from "../crypto/cipher";
import { fromBase64 } from "../crypto/encoding";

export interface RemoteNote extends EncryptedNote {
  version: number;
  updatedAt: number;
}

export interface NotesApi {
  getNote(id: string): Promise<RemoteNote | null>;
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
  };
}
