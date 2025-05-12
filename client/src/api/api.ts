import axiosInstance from "../axios";
import { Note } from "../types/notes";

export const fetchNoteById = async (noteId: string) => {
  const { data } = await axiosInstance.get(`/note/${noteId}`);
  return data;
};

export const updateNote = async (note: Note): Promise<Note> => {
  const payload = { content: note.content };
  console.log(note)
  const { data } = await axiosInstance.put(`/note/${note.note_id}`, payload);
  return data;
};
