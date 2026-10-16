import { useEffect, useMemo, useSyncExternalStore } from "react";
import { deriveNoteKeys } from "../crypto/derive";
import { createNotesApi } from "./api";
import { NoteSync } from "./noteSync";
import { createPendingStore } from "./pending";

const api = createNotesApi();

/** Binds one note (by normalized name) to React. */
export function useNote(name: string) {
  const sync = useMemo(
    () => new NoteSync(name, { api, pending: createPendingStore(localStorage), derive: deriveNoteKeys }),
    [name],
  );

  useEffect(() => {
    void sync.start();
    const onOnline = () => sync.retryNow();
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("online", onOnline);
      sync.dispose();
    };
  }, [sync]);

  const snapshot = useSyncExternalStore(sync.subscribe, sync.getSnapshot);
  return { ...snapshot, setText: sync.setText, resolveConflict: sync.resolveConflict };
}
