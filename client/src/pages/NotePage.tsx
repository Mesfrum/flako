import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { normalizeName } from "../names/names";
import { copyText, type CopyResult } from "../components/copyText";
import { LiveTextarea } from "../components/LiveTextarea";
import type { LiveSnapshot, RemoteCursor } from "../live/liveNote";
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

type Tone = "idle" | "live" | "warning" | "negative";

interface Conn {
  tone: Tone;
  label: string;
  detail?: string; // longer explanation, shown as a tooltip
}

const DOT: Record<Tone, string> = {
  idle: "bg-muted",
  live: "bg-live",
  warning: "bg-warning",
  negative: "bg-negative",
};

function NoteEditor({ name }: { name: string }) {
  const note = useLiveNote(name);
  const { status } = note;
  const loading = status.kind === "deriving" || status.kind === "connecting";
  const slow = useTrueAfter(loading, QUIET_MS);

  let conn: Conn | null = null;
  if (status.kind === "deriving") conn = slow ? { tone: "idle", label: "Unlocking…" } : null;
  else if (status.kind === "connecting") conn = slow ? { tone: "idle", label: "Connecting…" } : null;
  else if (status.kind === "ready") conn = describeConn(note);

  let body: ReactNode;
  if (status.kind === "unreadable")
    body = (
      <Message title="This name can’t open this note">
        A note is stored under this name, but it can’t be decrypted with it. Editing is off so nothing gets overwritten.
        <Link
          to="/"
          className="mt-6 inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-on-primary"
        >
          Open another note
        </Link>
      </Message>
    );
  else if (status.kind === "error")
    body = (
      <Message title="Something went wrong">
        {status.message}.
        <button
          type="button"
          onClick={() => location.reload()}
          className="mt-6 inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-on-primary"
        >
          Reload
        </button>
      </Message>
    );
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
        placeholder="Type. It encrypts itself."
        label={`Note ${name}`}
        disabled={loading}
      />
    );

  return (
    <div className="mx-auto flex h-dvh max-w-[880px] flex-col px-4 sm:px-6">
      <header className="flex flex-wrap items-center gap-x-4 py-2 sm:h-16 sm:flex-nowrap sm:py-0">
        <Link
          to="/"
          className="-mx-2 flex h-11 items-center rounded-md px-2 text-[15px] font-semibold tracking-tight hover:bg-raised"
          title="Open another note"
        >
          flako
        </Link>
        <h1 className="order-last min-w-0 basis-full truncate pb-2 text-[17px] font-medium sm:order-none sm:basis-auto sm:flex-1 sm:pb-0">
          {name}
        </h1>
        <div className="ml-auto flex items-center gap-3">
          <Status conn={conn} cursors={note.cursors} />
          <CopyButton text={note.text} disabled={status.kind !== "ready"} />
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col pb-3 sm:pb-6">{body}</main>
    </div>
  );
}

function Status({ conn, cursors }: { conn: Conn | null; cursors: RemoteCursor[] }) {
  // The live region is always mounted so screen readers announce every change.
  return (
    <p aria-live="polite" title={conn?.detail} className="flex items-center gap-2 text-sm whitespace-nowrap">
      {conn && (
        <>
          {conn.tone === "live" && cursors.length > 0 ? (
            <Presence cursors={cursors} />
          ) : (
            <span aria-hidden className={`size-2 rounded-full ${DOT[conn.tone]}`} />
          )}
          <span>{conn.label}</span>
        </>
      )}
    </p>
  );
}

/** The other people here, each as a dot in their cursor's colour. */
function Presence({ cursors }: { cursors: RemoteCursor[] }) {
  const shown = cursors.slice(0, 4);
  return (
    <span aria-hidden className="flex -space-x-1">
      {shown.map((c) => (
        <span key={c.from} className="size-2.5 rounded-full ring-2 ring-ground" style={{ background: c.color }} />
      ))}
    </span>
  );
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center rounded-lg border border-line bg-surface p-6">
      <div className="flex max-w-md flex-col items-start text-[15px] leading-relaxed">
        <h2 className="mb-2 text-lg font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

const COPY_LABEL: Record<"copy" | CopyResult, string> = {
  copy: "Copy",
  copied: "Copied",
  "copy failed": "Couldn’t copy",
};

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
    <button
      type="button"
      onClick={copy}
      disabled={disabled}
      aria-label={label === "copy" ? "Copy the whole note" : undefined}
      className={`h-9 min-w-[4.5rem] rounded-md bg-raised px-3 text-sm font-medium transition-[transform,background-color] hover:bg-control active:scale-[0.97] disabled:opacity-40 disabled:hover:bg-raised ${label === "copy failed" ? "text-negative" : ""}`}
    >
      {COPY_LABEL[label]}
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

function describeConn(s: Pick<LiveSnapshot, "full" | "conn" | "unsent" | "here">): Conn {
  if (s.full) return { tone: "negative", label: "Note is full", detail: "This note has reached its size limit." };
  if (s.conn === "busy")
    return { tone: "warning", label: "Note is busy", detail: "Too many people have this note open. Retrying." };
  if (s.conn === "offline")
    return {
      tone: "warning",
      label: s.unsent > 0 ? `Offline · ${s.unsent} to sync` : "Offline",
      detail: "Your edits are kept in this browser and sync when the connection is back.",
    };
  if (s.conn === "connecting") return { tone: "idle", label: "Connecting…" };
  return { tone: "live", label: s.here > 1 ? `Live · ${s.here} here` : "Live · just you" };
}
