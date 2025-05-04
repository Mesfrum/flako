import { useCallback, useEffect, useRef, useState } from "react";
import { Note } from "../types/notes";
import { loadNoteFromStorage, saveNoteToStorage } from "../utils/storage";
export function useNote(id: string | undefined, delay = 1000) {
  const [note, setNote] = useState<Note | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!id) return;

    const existingNote = loadNoteFromStorage(id);
    if (existingNote) {
      setNote(existingNote);
    } else {
      const newNote: Note = {
        id,
        content: "",
        updatedAt: Date.now(),
      };
      setNote(newNote);
      saveNoteToStorage(newNote);
    }
  }, [id]);

  useEffect(() => {
    if (!note) return;

    if (timeout.current) clearTimeout(timeout.current);

    timeout.current = setTimeout(() => {
      const updatedNote = { ...note, updatedAt: Date.now() };
      setNote(updatedNote);
      saveNoteToStorage(updatedNote);
    }, delay);

    return () => {
      if (timeout.current) clearTimeout(timeout.current);
    };
  }, [note, delay]);

  const handleContentChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setNote((prev) => (prev ? { ...prev, content: value } : prev));
    },
    []
  );

  return {
    note,
    handleContentChange,
  };
}
