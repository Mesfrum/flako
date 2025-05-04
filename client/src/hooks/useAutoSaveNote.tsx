// this file is not in use, logic is moved to ./useNote.tsx hook

import { useEffect, useRef } from "react";
import { Note } from "../types/notes";

export function useAutoSaveNote(
  note: Note,
  onSave: (note: Note) => void,
  delay = 1000
) {
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timeout.current) clearTimeout(timeout.current);

    timeout.current = setTimeout(() => {
      onSave({ ...note, updatedAt: Date.now() });
    }, delay);

    return () => {
      if (timeout.current) clearTimeout(timeout.current);
    };
  }, [note, delay]);
}
