import { useEffect, useMemo, useSyncExternalStore } from "react";
import { noteKeys } from "../crypto/keyCache";
import { createNotesApi } from "../notes/api";
import { createPendingStore } from "../notes/pending";
import { LiveNote } from "./liveNote";
import { createOutbox } from "./outbox";
import { webSocketConnect } from "./wsTransport";

const connect = webSocketConnect();
const api = createNotesApi();

/** Binds one live note (by normalized name) to React. */
export function useLiveNote(name: string) {
  const note = useMemo(
    () =>
      new LiveNote(name, {
        connect,
        api,
        outbox: createOutbox(localStorage),
        legacyPending: createPendingStore(localStorage),
        derive: noteKeys.get, // reuses Home's prefetch when the name was typed there
      }),
    [name],
  );

  useEffect(() => {
    void note.start();
    const onOnline = () => note.retryNow();
    // Closing the tab skips React cleanup, so ask the browser to warn while edits are unsent.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (note.hasUnsentWork()) e.preventDefault();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("beforeunload", onBeforeUnload);
      note.dispose();
    };
  }, [note]);

  const snapshot = useSyncExternalStore(note.subscribe, note.getSnapshot);
  return {
    ...snapshot,
    change: note.change,
    select: note.select,
    undo: note.undo,
    redo: note.redo,
    setComposing: note.setComposing,
  };
}
