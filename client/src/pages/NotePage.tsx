import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { normalizeName } from "../names/names";
import { copyText, type CopyResult } from "../components/copyText";
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

// Loads faster than this never flash a status message.
const QUIET_MS = 300;

function NoteEditor({ name }: { name: string }) {
  const note = useLiveNote(name);
  const { status } = note;
  const loading = status.kind === "deriving" || status.kind === "connecting";
  const slow = useTrueAfter(loading, QUIET_MS);

  let conn = "";
  if (status.kind === "deriving") conn = slow ? "unlocking…" : "";
  else if (status.kind === "connecting") conn = slow ? "connecting…" : "";
  else if (status.kind === "ready") conn = describeConn(note);

  let body: ReactNode;
  if (status.kind === "unreadable")
    body = <Message>this note exists but cannot be decrypted with this name. editing is disabled.</Message>;
  else if (status.kind === "error") body = <Message>{status.message}. reload to try again.</Message>;
  else
    body = (
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
        disabled={loading}
      />
    );

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-3 p-6">
      <header className="flex items-baseline justify-between gap-4 text-sm">
        <Link to="/" className="underline">
          home
        </Link>
        <span className="truncate font-mono">/{name}</span>
        <span className="flex items-baseline gap-4">
          <span aria-live="polite">{conn}</span>
          <CopyButton text={note.text} disabled={status.kind !== "ready"} />
        </span>
      </header>
      {body}
    </main>
  );
}

function Message({ children }: { children: ReactNode }) {
  return <p className="p-10 text-center font-mono text-sm">{children}</p>;
}

function CopyButton({ text, disabled }: { text: string; disabled: boolean }) {
  const [label, setLabel] = useState<"copy" | CopyResult>("copy");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    setLabel(await copyText(text, navigator.clipboard));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setLabel("copy"), 1500);
  };

  return (
    <button type="button" onClick={copy} disabled={disabled} className="underline disabled:opacity-50">
      {label}
    </button>
  );
}

/** True once `active` has stayed true for `ms`; false again as soon as it turns false. */
function useTrueAfter(active: boolean, ms: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setElapsed(true), ms);
    return () => {
      clearTimeout(t);
      setElapsed(false);
    };
  }, [active, ms]);
  return active && elapsed;
}

function describeConn(s: Pick<LiveSnapshot, "full" | "conn" | "unsent" | "here">): string {
  if (s.full) return "note is full";
  if (s.conn === "busy") return "note is busy";
  if (s.conn === "offline") return s.unsent > 0 ? `offline — will sync (${s.unsent} unsent)` : "offline — will sync";
  if (s.conn === "connecting") return "connecting…";
  return `live · ${s.here} here`;
}
