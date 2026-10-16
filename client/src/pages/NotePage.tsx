import type { ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { normalizeName } from "../names/names";
import type { SaveState } from "../notes/noteSync";
import { useNote } from "../notes/useNote";

function nameFromPath(pathname: string): string {
  const raw = pathname.slice(1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // malformed escape like "%E0%A4%A": treat literally
  }
}

export default function NotePage() {
  const { pathname } = useLocation();
  const decoded = nameFromPath(pathname);
  const name = normalizeName(decoded);

  if (!name) return <Navigate to="/" replace />;
  // Compare decoded forms so an encoded canonical URL never redirects again (no loops).
  if (name !== decoded) return <Navigate to={`/${encodeURIComponent(name)}`} replace />;
  return <NoteEditor key={name} name={name} />;
}

function NoteEditor({ name }: { name: string }) {
  const { status, text, setText, resolveConflict } = useNote(name);

  if (status.kind === "deriving") return <Centered>deriving keys for “{name}”…</Centered>;
  if (status.kind === "loading") return <Centered>fetching…</Centered>;
  if (status.kind === "unreadable")
    return <Centered>this note exists but cannot be decrypted with this name. saving is disabled.</Centered>;
  if (status.kind === "error") return <Centered>{status.message}. reload to try again.</Centered>;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-3 p-6">
      <header className="flex items-baseline justify-between gap-4 text-sm">
        <Link to="/" className="underline">
          home
        </Link>
        <span className="truncate font-mono">/{name}</span>
        <span aria-live="polite">{describeSave(status.save)}</span>
      </header>

      {status.save.kind === "conflict" && (
        <div role="alert" className="flex flex-wrap gap-3 border p-3 text-sm">
          <span>this note was changed somewhere else.</span>
          <button className="underline" onClick={() => void resolveConflict("theirs")}>
            load theirs
          </button>
          <button className="underline" onClick={() => void resolveConflict("mine")}>
            overwrite with mine
          </button>
        </div>
      )}

      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="type. it encrypts itself."
        className="min-h-[70vh] w-full resize-none border p-4 font-mono focus:outline-none"
      />
    </main>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <p className="p-10 text-center font-mono text-sm">{children}</p>;
}

function describeSave(save: SaveState): string {
  switch (save.kind) {
    case "clean":
      return save.savedAt ? `saved ${new Date(save.savedAt).toLocaleTimeString()}` : "nothing saved yet";
    case "dirty":
      return "unsaved changes";
    case "saving":
      return "saving…";
    case "unsaved":
      return `offline: retrying in ${Math.round(save.retryInMs / 1000)}s`;
    case "conflict":
      return "conflict";
    case "tooLarge":
      return "too large to save";
  }
}
