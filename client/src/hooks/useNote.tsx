import { useEffect, useRef, useState } from "react";
import { Note } from "../types/notes";
import { loadNoteFromStorage, saveNoteToStorage } from "../utils/storage";
import { useFetchNote } from "./fetchNotes/useFetchNote";
import { useUpdateNote } from "./updateNote/useUpdateNote";

export function useNote(id: string | undefined, delay = 1000) {
  const [inputNote, setInputNote] = useState<Note | null>(null);
  const [savedNote, setSavedNote] = useState<Note | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { data } = useFetchNote(id ?? "");
  const updateMutation = useUpdateNote();

  /**
   * Load the note on mount
   */
  useEffect(() => {
    if (!id || !data) return;

    setInputNote(data);
    setSavedNote(data);
    saveNoteToStorage(data);

  }, [id, data]);

  /**
   * Debounced save: now using API call instead of localStorage
   */
  const queueSave = (noteToSave: Note) => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    debounceTimer.current = setTimeout(() => {
      const updatedNote = { ...noteToSave, updatedAt: Date.now() };

      updateMutation.mutate(updatedNote, {
        onSuccess: (data) => {
          setSavedNote(data);
        },
        onError: (err) => {
          console.error("API update failed, saving to localStorage", err);
          saveNoteToStorage(updatedNote); // Fallback local save
          setSavedNote(updatedNote);
        },
      });
    }, delay);
  };

  /**
   * Real-time content updates
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
    note: inputNote,
    handleContentChange,
    savedAt: savedNote?.updatedAt,
    isSaving: updateMutation.status === "pending",
    hasError: updateMutation.status === "error",
  };
}
