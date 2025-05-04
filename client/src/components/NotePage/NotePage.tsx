import { useParams } from "react-router-dom";
import { useNote } from "../../hooks/useNote";

export default function NotePage() {
  const { id } = useParams<{ id: string }>();
  const { note, handleContentChange } = useNote(id);

  if (!note) {
    return <p className="text-center mt-10">Loading note...</p>;
  }

  return (
    <div className="container mx-auto px-16 py-8 min-h-screen">
      <textarea
        className="w-full h-full border border-slate-500 p-4"
        rows={20}
        placeholder="Start typing..."
        value={note.content}
        onChange={handleContentChange}
      />
    </div>
  );
}
