import type { ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { normalizeName } from "../names/names";
import { LiveTextarea } from "../components/LiveTextarea";
import type { LiveSnapshot } from "../live/liveNote";
import { useLiveNote } from "../live/useLiveNote";

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
  const note = useLiveNote(name);
  const { status } = note;

  if (status.kind === "deriving") return <Centered>deriving keys for “{name}”…</Centered>;
  if (status.kind === "connecting") return <Centered>connecting…</Centered>;
  if (status.kind === "unreadable")
    return <Centered>this note exists but cannot be decrypted with this name. editing is disabled.</Centered>;
  if (status.kind === "error") return <Centered>{status.message}. reload to try again.</Centered>;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-3 p-6">
      <header className="flex items-baseline justify-between gap-4 text-sm">
        <Link to="/" className="underline">
          home
        </Link>
        <span className="truncate font-mono">/{name}</span>
        <span aria-live="polite">{describeConn(note)}</span>
      </header>
      <LiveTextarea
        text={note.text}
        selection={note.selection}
        onChange={note.change}
        onSelect={note.select}
        onUndo={note.undo}
        onRedo={note.redo}
        onComposing={note.setComposing}
        cursors={note.cursors}
        placeholder="type. it encrypts itself."
      />
    </main>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <p className="p-10 text-center font-mono text-sm">{children}</p>;
}

function describeConn(s: Pick<LiveSnapshot, "full" | "conn" | "unsent" | "here">): string {
  if (s.full) return "note is full";
  if (s.conn === "busy") return "note is busy";
  if (s.conn === "offline") return s.unsent > 0 ? `offline — will sync (${s.unsent} unsent)` : "offline — will sync";
  if (s.conn === "connecting") return "connecting…";
  return `live · ${s.here} here`;
}
