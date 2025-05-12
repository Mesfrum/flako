import { useParams } from "react-router-dom";
import { useNote } from "../../hooks/useNote";
import { Loader2, CheckCircle2 } from "lucide-react";

export default function NotePage() {
  const { id: noteId } = useParams<{ id: string }>();
  const { note, handleContentChange, savedAt, isSaving } = useNote(noteId);

  if (!note) {
    return <p className="text-center mt-10">Loading note...</p>;
  }

  return (
    <div className="container mx-auto px-16 py-8 min-h-screen">
      {/* Save status */}
      <div className="flex items-center gap-2 mb-2 text-sm text-slate-600">
        {isSaving ? (
          <>
            <Loader2 className="animate-spin w-4 h-4 text-blue-500" />
            <span>Saving...</span>
          </>
        ) : savedAt ? (
          <>
            <CheckCircle2 className="w-4 h-4 text-green-500" />
            <span>Saved at {new Date(savedAt).toLocaleTimeString()}</span>
          </>
        ) : (
          <span>No changes yet</span>
        )}
      </div>

      {/* Text editor */}
      <textarea
        className="w-full h-full border border-slate-500 p-4 rounded resize-none focus:outline-none focus:ring-2 focus:ring-blue-400"
        rows={20}
        placeholder="Start typing..."
        value={note.content}
        onChange={handleContentChange}
      />
    </div>
  );
}
