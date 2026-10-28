import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { normalizeName } from "../names/names";
import { copyText, type CopyResult } from "../components/copyText";
import { LiveTextarea } from "../components/LiveTextarea";
import type { LiveSnapshot, RemoteCursor } from "../live/liveNote";
import { useLiveNote } from "../live/useLiveNote";
import { ThemeToggle } from "../theme/ThemeToggle";

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
          className="mt-6 inline-flex h-10 items-center rounded-box bg-primary px-4 text-sm font-medium text-on-primary"
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
          className="mt-6 inline-flex h-10 items-center rounded-box bg-primary px-4 text-sm font-medium text-on-primary"
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
          className="-mx-2 flex h-11 items-center rounded-box px-2 text-[15px] font-semibold tracking-tight hover:bg-raised"
          title="Open another note"
        >
          flako
        </Link>
        <div className="order-last flex min-w-0 basis-full items-center gap-1 pb-2 sm:order-none sm:flex-1 sm:basis-auto sm:pb-0">
          <h1 className="min-w-0 truncate text-[17px] font-medium">{name}</h1>
          <CopyLinkButton />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Status conn={conn} cursors={note.cursors} />
          <CopyButton text={note.text} disabled={status.kind !== "ready"} />
          <ThemeToggle />
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
    <div className="flex flex-1 items-center justify-center rounded-box border border-line bg-surface p-6">
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

/** Shows a copy result for a moment, then falls back to the idle label. */
function useCopy(): [CopyResult | null, (text: string) => Promise<void>] {
  const [result, setResult] = useState<CopyResult | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async (text: string) => {
    setResult(await copyText(text, navigator.clipboard));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setResult(null), 1500);
  };
  return [result, copy];
}

function CopyButton({ text, disabled }: { text: string; disabled: boolean }) {
  const [result, copy] = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(text)}
      disabled={disabled}
      aria-label={result ? undefined : "Copy the whole note"}
      className={`h-9 min-w-[4.5rem] rounded-box bg-raised px-3 text-sm font-medium transition-[transform,background-color] hover:bg-line active:scale-[0.97] disabled:opacity-40 disabled:hover:bg-raised ${result === "copy failed" ? "text-negative" : ""}`}
    >
      {COPY_LABEL[result ?? "copy"]}
    </button>
  );
}

/** Copies this page's address. The name in it is the key, so this is how a note is shared. */
function CopyLinkButton() {
  const [result, copy] = useCopy();
  const label = result === "copied" ? "Link copied" : result === "copy failed" ? "Couldn’t copy link" : "Copy link";
  return (
    <span className="flex shrink-0 items-center">
      <button
        type="button"
        onClick={() => copy(location.href)}
        aria-label={label}
        title="Copy link to this note"
        className="grid size-8 place-items-center rounded-box text-muted transition-colors hover:bg-raised hover:text-ink"
      >
        {result === "copied" ? <CheckIcon /> : <LinkIcon />}
      </button>
      <span aria-live="polite" className={`text-sm ${result === "copy failed" ? "text-negative" : "text-muted"}`}>
        {result && label}
      </span>
    </span>
  );
}

const iconProps = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function LinkIcon() {
  return (
    <svg {...iconProps}>
      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
      <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg {...iconProps}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
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
