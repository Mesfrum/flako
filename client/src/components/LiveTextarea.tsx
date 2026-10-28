import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RemoteCursor } from "../live/liveNote";
import { RemoteCursors } from "./RemoteCursors";

interface Props {
  text: string;
  selection: { start: number; end: number };
  onChange(next: string, start: number, end: number): void;
  onSelect(start: number, end: number): void;
  onUndo(): void;
  onRedo(): void;
  onComposing(on: boolean): void;
  cursors: RemoteCursor[];
  placeholder: string;
  label: string; // accessible name; the textarea has no visible label
  disabled?: boolean; // shown but locked while the note loads
}

// Shared by the textarea and the cursor overlay so both wrap text identically.
// Monospace on purpose: notes are plain text, so pasted code, lists and tables keep their columns.
const TEXT_CLASSES = "px-4 py-4 sm:px-7 sm:py-6 font-mono text-[15px] leading-[1.7] whitespace-pre-wrap break-words";

/** A controlled textarea driven by the LiveNote engine, with remote cursors drawn on top. */
export function LiveTextarea(props: Props) {
  const { text, selection, onChange, onSelect, onUndo, onRedo, onComposing, cursors, placeholder, label, disabled } =
    props;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [box, setBox] = useState({ width: 0, height: 0 });

  // autoFocus is ignored on a disabled textarea, so focus it once it unlocks (unless the user
  // has already moved focus somewhere else, e.g. into the address bar or a button).
  useEffect(() => {
    const el = ref.current;
    if (disabled || !el) return;
    if (document.activeElement === null || document.activeElement === document.body) el.focus();
  }, [disabled]);

  // Put the caret where the engine says, before paint (remote edits must not move it).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || document.activeElement !== el) return;
    if (el.selectionStart !== selection.start || el.selectionEnd !== selection.end) {
      el.setSelectionRange(selection.start, selection.end);
    }
  }, [text, selection.start, selection.end]);

  // The overlay must match the textarea's inner box (without its scrollbar) to wrap the same way.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // Menu-driven undo/redo (and mobile) arrive as beforeinput, not keydown.
    const onBeforeInput = (e: InputEvent) => {
      if (e.inputType === "historyUndo") {
        e.preventDefault();
        onUndo();
      } else if (e.inputType === "historyRedo") {
        e.preventDefault();
        onRedo();
      }
    };
    el.addEventListener("beforeinput", onBeforeInput);
    return () => {
      ro.disconnect();
      el.removeEventListener("beforeinput", onBeforeInput);
    };
  }, [onUndo, onRedo]);

  const reportSelection = () => {
    const el = ref.current;
    if (el) onSelect(el.selectionStart, el.selectionEnd);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <textarea
        ref={ref}
        autoFocus
        value={text}
        placeholder={disabled ? "" : placeholder}
        aria-label={label}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value, e.target.selectionStart, e.target.selectionEnd)}
        onSelect={reportSelection}
        onKeyUp={reportSelection}
        onMouseUp={reportSelection}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onCompositionStart={() => onComposing(true)}
        onCompositionEnd={() => onComposing(false)}
        onKeyDown={(e) => {
          const mod = e.ctrlKey || e.metaKey;
          if (!mod) return;
          const key = e.key.toLowerCase();
          if (key === "z") {
            e.preventDefault();
            if (e.shiftKey) onRedo();
            else onUndo();
          } else if (key === "y") {
            e.preventDefault();
            onRedo();
          }
        }}
        className={`block h-full w-full resize-none rounded-box border border-line bg-surface text-ink transition-[opacity,border-color] duration-150 placeholder:text-muted focus:border-control focus:outline-none disabled:opacity-50 ${TEXT_CLASSES}`}
      />
      <RemoteCursors
        text={text}
        cursors={cursors}
        scrollTop={scrollTop}
        width={box.width}
        height={box.height}
        className={TEXT_CLASSES}
      />
    </div>
  );
}
