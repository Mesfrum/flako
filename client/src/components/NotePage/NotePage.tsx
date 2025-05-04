import React, { useCallback, useState } from "react";
import { Note } from "../../types/notes";
import { useAutoSaveNote } from "../../hooks/useAutoSaveNote";

export default function NotePage() {
  const [note, setNote] = useState<Note>(() => {
    const saved = localStorage.getItem("note");
    return saved
      ? JSON.parse(saved)
      : { id: "local-note", content: "", updatedAt: Date.now() };
  });

  // Auto-save to localStorage
  const handleSave = useCallback((newNote: Note) => {
    localStorage.setItem("note", JSON.stringify(newNote));
  }, []);

  useAutoSaveNote(note, handleSave);

  //   handle note change
  const handleNoteChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setNote((prev) => ({ ...prev, content: e.target.value }));
  };

  return (
    <div className="container mx-auto px-16 py-8 min-h-screen">
      <textarea
        className="w-full h-full border border-slate-500 p-4"
        rows={20}
        placeholder="..."
        value={note.content}
        onChange={handleNoteChange}
      />
    </div>
  );
}
