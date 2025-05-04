import { Note } from "../types/notes";

const STORAGE_PREFIX = "";

export function loadNoteFromStorage(id: string): Note | null {
  const raw = localStorage.getItem(`${STORAGE_PREFIX}${id}`);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as Note;
  } catch {
    return null;
  }
}

export function saveNoteToStorage(note: Note): void {
  localStorage.setItem(`${STORAGE_PREFIX}${note.id}`, JSON.stringify(note));
}
