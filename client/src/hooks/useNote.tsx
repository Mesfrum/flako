import { useEffect, useRef, useState } from "react";
import { Note } from "../types/notes";
import { loadNoteFromStorage, saveNoteToStorage } from "../utils/storage";

export function useNote(id: string | undefined, delay = 1000) {
  const [inputNote, setInputNote] = useState<Note | null>(null);
  const [savedNote, setSavedNote] = useState<Note | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 1. Load the note on mount (initial fetch)
   * Replace with API call or socket emit to fetch a note
   */
  useEffect(() => {
    if (!id) return;

    const stored = loadNoteFromStorage(id); // Replace with: await fetchNote(id);
    const initialNote = stored ?? { id, content: "", updatedAt: Date.now() };

    setInputNote(initialNote);
    setSavedNote(initialNote);

    if (!stored) {
      saveNoteToStorage(initialNote); // Replace with: await saveNote(initialNote);
    }
  }, [id]);

  /**
   * 2. Queue a save when content changes (debounced)
   * Replace saveNoteToStorage with API/socket send
   */
  const queueSave = (noteToSave: Note) => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    debounceTimer.current = setTimeout(() => {
      const updatedNote = { ...noteToSave, updatedAt: Date.now() };

      // TODO: Replace with API call or socket emit to save note
      saveNoteToStorage(updatedNote);
      setSavedNote(updatedNote);
    }, delay);
  };

  /**
   * 3. Handle real-time content updates from the user
   */
  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newContent = e.target.value;

    setInputNote((prev) => {
      if (!prev) return prev;

      const updated = { ...prev, content: newContent };
      queueSave(updated);
      return updated;
    });
  };

  return {
    note: inputNote, // For displaying the current note
    handleContentChange, // For updating content
    savedAt: savedNote?.updatedAt, // Useful for "Last saved" status
  };
}
