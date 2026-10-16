import { DecryptError, decryptNote, encryptNote } from "../crypto/cipher";
import type { NoteKeys } from "../crypto/derive";
import { ConflictError, TooLargeError, isRetryable, type NotesApi } from "./api";
import type { PendingSave, PendingStore } from "./pending";

export type SaveState =
  | { kind: "clean"; savedAt: number | null } // savedAt null: nothing on the server yet
  | { kind: "dirty" } // edits waiting for the debounce
  | { kind: "saving" }
  | { kind: "unsaved"; retryInMs: number } // offline / server error; retry scheduled
  | { kind: "conflict" } // someone else saved first; user must choose
  | { kind: "tooLarge" };

export type NoteStatus =
  | { kind: "deriving" }
  | { kind: "loading" }
  | { kind: "ready"; save: SaveState }
  | { kind: "unreadable" }
  | { kind: "error"; message: string };

export interface NoteSnapshot {
  status: NoteStatus;
  text: string;
}

export interface NoteSyncDeps {
  api: NotesApi;
  pending: PendingStore;
  derive: (name: string) => Promise<NoteKeys>;
  debounceMs?: number;
}

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

/**
 * Owns one note's lifecycle: derive keys, load + decrypt, debounced encrypted
 * saves (one in flight at a time), conflicts, and offline retry. Framework-free;
 * React binds to it with useSyncExternalStore (see useNote.ts).
 */
export class NoteSync {
  private readonly name: string;
  private readonly deps: NoteSyncDeps;
  private readonly debounceMs: number;
  private readonly listeners = new Set<() => void>();

  private snapshot: NoteSnapshot = { status: { kind: "deriving" }, text: "" };
  private keys: NoteKeys | null = null;
  private version = 0; // server version our text is based on
  private dirty = false; // local text differs from what the last started save sent
  private inFlight = false;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelayMs = FIRST_RETRY_MS;
  private run = 0; // bumps on start/dispose; UI updates from an older run are ignored
  private disposed = false;
  private flushAfterSettle = false; // dispose() arrived while a save was in flight
  private pendingSeq = 0; // bumps on every pending write/clear; stale async writes are dropped

  constructor(name: string, deps: NoteSyncDeps) {
    this.name = name;
    this.deps = deps;
    this.debounceMs = deps.debounceMs ?? 1000;
  }

  // Arrow properties so React can pass them around without losing `this`.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): NoteSnapshot => this.snapshot;

  async start(): Promise<void> {
    const run = ++this.run;
    this.disposed = false;
    this.set({ status: { kind: "deriving" } });
    try {
      const keys = await this.deps.derive(this.name);
      if (run !== this.run) return;
      this.keys = keys;
      this.set({ status: { kind: "loading" } });

      const remote = await this.deps.api.getNote(keys.id);
      if (run !== this.run) return;
      const text = remote ? await decryptNote(keys.key, keys.id, remote) : "";
      if (run !== this.run) return;

      this.version = remote?.version ?? 0;
      this.dirty = false;
      this.set({ text, status: { kind: "ready", save: { kind: "clean", savedAt: remote?.updatedAt ?? null } } });
      await this.resumePending(run);
    } catch (err) {
      if (run !== this.run) return;
      if (err instanceof DecryptError) {
        this.set({ status: { kind: "unreadable" } });
      } else {
        this.set({ status: { kind: "error", message: "could not load this note" } });
      }
    }
  }

  setText = (text: string): void => {
    const status = this.snapshot.status;
    if (status.kind !== "ready") return;
    this.dirty = true;
    const save = status.save;
    // Conflict waits for the user; unsaved has a retry timer; saving re-flushes when done.
    const keep = save.kind === "conflict" || save.kind === "unsaved" || save.kind === "saving";
    this.set({ text, status: { kind: "ready", save: keep ? save : { kind: "dirty" } } });
    if (save.kind === "conflict" || save.kind === "unsaved") {
      // No save is coming soon, so keep the stored ciphertext current in case the tab closes.
      void this.persistPending();
      return;
    }
    this.scheduleSave();
  };

  /** True while something typed has not reached the server (the page warns before closing). */
  hasUnsavedWork = (): boolean => {
    const status = this.snapshot.status;
    return status.kind === "ready" && status.save.kind !== "clean";
  };

  resolveConflict = async (choice: "theirs" | "mine"): Promise<void> => {
    const keys = this.keys;
    if (!keys) return;
    const run = this.run;
    try {
      const remote = await this.deps.api.getNote(keys.id);
      if (run !== this.run) return;
      this.version = remote?.version ?? 0;
      if (choice === "theirs") {
        const text = remote ? await decryptNote(keys.key, keys.id, remote) : "";
        if (run !== this.run) return;
        this.dirty = false;
        this.clearPending(keys.id);
        this.set({ text, status: { kind: "ready", save: { kind: "clean", savedAt: remote?.updatedAt ?? null } } });
      } else {
        this.dirty = true;
        this.setSave({ kind: "dirty" });
        await this.flush();
      }
    } catch (err) {
      if (run !== this.run) return;
      if (err instanceof DecryptError) this.set({ status: { kind: "unreadable" } });
      else this.setSave({ kind: "conflict" }); // still unresolved; the user can try again
    }
  };

  /** Retry a failed save now (e.g. the browser fired "online"). */
  retryNow = (): void => {
    if (this.retryTimer === undefined) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    void this.flush();
  };

  dispose(): void {
    this.disposed = true;
    // Best effort: send what was typed in the last second. A save already in flight
    // re-flushes when it settles, so the newest keystrokes are not dropped.
    if (this.inFlight) this.flushAfterSettle = true;
    else if (this.dirty) void this.flush();
    this.run++;
    clearTimeout(this.debounceTimer);
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private async resumePending(run: number): Promise<void> {
    const keys = this.keys!;
    const pending = this.deps.pending.load(keys.id);
    if (!pending) return;
    let text: string;
    try {
      text = await decryptNote(keys.key, keys.id, pending.encrypted);
    } catch {
      this.clearPending(keys.id); // not ours / corrupt: drop it
      return;
    }
    if (run !== this.run) return;
    this.version = pending.baseVersion; // if the server moved on, the PUT will 409 → conflict
    this.dirty = true;
    this.set({ text, status: { kind: "ready", save: { kind: "dirty" } } });
    await this.flush();
  }

  private scheduleSave(): void {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  /**
   * Persistence (version, pending) always happens, even after dispose, so a
   * closed editor never leaves stale pending text behind. Only UI updates and
   * timers are skipped once this run is no longer live.
   */
  private async flush(): Promise<void> {
    const keys = this.keys;
    if (!keys || this.inFlight || !this.dirty) return;
    const run = this.run;
    const live = () => run === this.run && !this.disposed;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.inFlight = true;
    this.dirty = false;
    if (live()) this.setSave({ kind: "saving" });

    try {
      const sentText = this.snapshot.text;
      const encrypted = await encryptNote(keys.key, keys.id, sentText);
      try {
        const res = await this.deps.api.putNote(keys.id, encrypted, this.version);
        this.version = res.version;
        this.clearPending(keys.id);
        if (!live()) return;
        this.retryDelayMs = FIRST_RETRY_MS;
        if (this.dirty) {
          this.setSave({ kind: "dirty" });
          this.scheduleSave();
        } else {
          this.setSave({ kind: "clean", savedAt: res.updatedAt });
        }
      } catch (err) {
        this.dirty = true;
        if (err instanceof TooLargeError) {
          clearTimeout(this.debounceTimer);
          if (live()) this.setSave({ kind: "tooLarge" });
          return;
        }
        // Keep the newest text, not just what this attempt sent.
        const latest =
          this.snapshot.text === sentText ? encrypted : await encryptNote(keys.key, keys.id, this.snapshot.text);
        this.savePending(keys.id, { encrypted: latest, baseVersion: this.version });
        if (err instanceof ConflictError) clearTimeout(this.debounceTimer); // a stale PUT would just 409 again
        if (!live()) return;
        if (err instanceof ConflictError) {
          this.setSave({ kind: "conflict" });
        } else if (isRetryable(err)) {
          const delay = this.retryDelayMs;
          this.retryDelayMs = Math.min(delay * 2, MAX_RETRY_MS);
          this.setSave({ kind: "unsaved", retryInMs: delay });
          this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            void this.flush();
          }, delay);
        } else {
          this.set({ status: { kind: "error", message: "the server rejected this save" } });
        }
      }
    } finally {
      this.inFlight = false;
      if (this.flushAfterSettle) {
        this.flushAfterSettle = false;
        void this.flush(); // no-op unless edits arrived during the save
      }
    }
  }

  /** Re-encrypt the current text into pending (used while no save is scheduled soon). */
  private async persistPending(): Promise<void> {
    const keys = this.keys;
    if (!keys) return;
    const seq = ++this.pendingSeq;
    const encrypted = await encryptNote(keys.key, keys.id, this.snapshot.text);
    if (seq !== this.pendingSeq) return; // a newer write or a clear happened meanwhile
    this.deps.pending.save(keys.id, { encrypted, baseVersion: this.version });
  }

  private savePending(id: string, pending: PendingSave) {
    this.pendingSeq++;
    this.deps.pending.save(id, pending);
  }

  private clearPending(id: string) {
    this.pendingSeq++;
    this.deps.pending.clear(id);
  }

  private setSave(save: SaveState): void {
    if (this.snapshot.status.kind === "ready") this.set({ status: { kind: "ready", save } });
  }

  private set(patch: Partial<NoteSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }; // new object → React sees the change
    for (const listener of this.listeners) listener();
  }
}
