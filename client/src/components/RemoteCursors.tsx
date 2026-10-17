import type { CSSProperties, ReactNode } from "react";
import type { RemoteCursor } from "../live/liveNote";

interface Props {
  text: string;
  cursors: RemoteCursor[];
  scrollTop: number;
  width: number;
  height: number;
  className: string; // same text classes as the textarea, so lines wrap identically
}

/**
 * A transparent copy of the textarea's text laid exactly over it. Selections become tinted
 * <mark>s and carets 2px bars, so they land on the right characters even across wrapped lines.
 */
export function RemoteCursors({ text, cursors, scrollTop, width, height, className }: Props) {
  if (cursors.length === 0 || width === 0) return null;

  // Cut the text at every selection edge; colour each piece by the first selection covering it.
  const edges = new Set<number>([0, text.length]);
  for (const c of cursors) {
    edges.add(clamp(Math.min(c.start, c.end), text.length));
    edges.add(clamp(Math.max(c.start, c.end), text.length));
  }
  const points = [...edges].sort((a, b) => a - b);
  const pieces: ReactNode[] = [];
  for (let i = 0; i < points.length; i++) {
    const at = points[i];
    for (const c of cursors) {
      if (clamp(c.end, text.length) === at) pieces.push(<Caret key={`caret-${c.from}`} color={c.color} />);
    }
    if (i === points.length - 1) break;
    const next = points[i + 1];
    const cover = cursors.find((c) => Math.min(c.start, c.end) <= at && Math.max(c.start, c.end) >= next);
    const chunk = text.slice(at, next);
    pieces.push(
      cover ? (
        <mark key={`sel-${at}`} style={{ background: `${cover.color}40`, color: "transparent" }}>
          {chunk}
        </mark>
      ) : (
        <span key={`txt-${at}`}>{chunk}</span>
      ),
    );
  }

  const style: CSSProperties = { width, height, color: "transparent" };
  return (
    <div aria-hidden className="pointer-events-none absolute left-px top-px overflow-hidden" style={style}>
      <div className={className} style={{ transform: `translateY(${-scrollTop}px)` }}>
        {pieces}
        {"​" /* keeps a trailing empty line measurable */}
      </div>
    </div>
  );
}

function Caret({ color }: { color: string }) {
  return (
    <span
      className="relative inline-block align-text-bottom"
      style={{ width: 0, height: "1.25em", borderLeft: `2px solid ${color}`, marginRight: -2 }}
    />
  );
}

const clamp = (n: number, max: number) => Math.max(0, Math.min(n, max));
