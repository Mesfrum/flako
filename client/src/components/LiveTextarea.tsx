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
}

// Shared by the textarea and the cursor overlay so both wrap text identically.
const TEXT_CLASSES = "p-4 font-mono text-base leading-6 whitespace-pre-wrap break-words";

/** A controlled textarea driven by the LiveNote engine, with remote cursors drawn on top. */
export function LiveTextarea(props: Props) {
  const { text, selection, onChange, onSelect, onUndo, onRedo, onComposing, cursors, placeholder } = props;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [box, setBox] = useState({ width: 0, height: 0 });

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
    <div className="relative">
      <textarea
        ref={ref}
        autoFocus
        value={text}
        placeholder={placeholder}
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
        className={`block min-h-[70vh] w-full resize-none border focus:outline-none ${TEXT_CLASSES}`}
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
