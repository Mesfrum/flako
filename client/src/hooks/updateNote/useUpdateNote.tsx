import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateNote } from "../../api/api";
import { Note } from "../../types/notes";

export function useUpdateNote() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (note: Note) => updateNote(note),
    onSuccess: (updatedNote) => {
      queryClient.setQueryData(["note_data", updatedNote.note_id], updatedNote);
    },
    onError: (error) => {
      console.error("Update failed:", error);
    },
  });
}
