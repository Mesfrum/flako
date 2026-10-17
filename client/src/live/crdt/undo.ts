import type { IdRange, Op, Rga } from "./rga";

/** Ops already applied to the Rga (broadcast them like any edit) and where the caret goes. */
export interface UndoResult {
  ops: Op[];
  caret: number;
}

/**
 * Selective undo: only MY edits, never a collaborator's. Undo applies the inverse of my ops
 * (insert → delete those ids, delete → undelete those ids); because the inverses are ordinary
 * CRDT ops they sync and converge like any other edit.
 */
export class UndoManager {
  private readonly rga: Rga;
  private readonly groupMs: number;
  private undoStack: Op[][] = [];
  private redoStack: Op[][] = [];
  private lastAt = -Infinity;
  private broken = true;

  constructor(rga: Rga, groupMs = 500) {
    this.rga = rga;
    this.groupMs = groupMs;
  }

  /** Call for every LOCAL edit op (not for undo/redo output, not for remote ops). */
  record(op: Op, now: number): void {
    this.redoStack = [];
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && !this.broken && now - this.lastAt < this.groupMs) top.push(op);
    else this.undoStack.push([op]);
    this.lastAt = now;
    this.broken = false;
  }

  /** The next record starts a new step (e.g. the caret was moved by a click or arrow key). */
  breakGroup(): void {
    this.broken = true;
  }

  undo(): UndoResult | null {
    const step = this.undoStack.pop();
    if (!step) return null;
    const ops = [...step].reverse().map((op) => this.invert(op));
    this.redoStack.push(step);
    this.broken = true;
    return { ops, caret: this.caretAfter(ops) };
  }

  redo(): UndoResult | null {
    const step = this.redoStack.pop();
    if (!step) return null;
    const ops = step.map((op) => this.reapply(op));
    this.undoStack.push(step);
    this.broken = true;
    return { ops, caret: this.caretAfter(ops) };
  }

  private invert(op: Op): Op {
    if (op.k === "ins") return this.rga.deleteIds([insertedRange(op)]);
    if (op.k === "del") return this.rga.undeleteIds(op.ranges);
    return this.rga.deleteIds(op.ranges);
  }

  private reapply(op: Op): Op {
    if (op.k === "ins") return this.rga.undeleteIds([insertedRange(op)]);
    if (op.k === "del") return this.rga.deleteIds(op.ranges);
    return this.rga.undeleteIds(op.ranges);
  }

  /** Just after the last restored character, or where the last removed one used to be. */
  private caretAfter(ops: Op[]): number {
    const last = ops[ops.length - 1];
    if (!last || last.k === "ins") return 0;
    if (last.k === "undel") {
      const rg = last.ranges[last.ranges.length - 1];
      return this.rga.indexOf({ r: rg.r, c: rg.c + rg.n - 1 }) + 1;
    }
    const rg = last.ranges[0];
    return this.rga.indexOf({ r: rg.r, c: rg.c });
  }
}

function insertedRange(op: Extract<Op, { k: "ins" }>): IdRange {
  return { r: op.id.r, c: op.id.c, n: op.text.length };
}
