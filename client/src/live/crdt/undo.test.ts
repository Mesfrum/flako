import { expect, it } from "vitest";
import { Rga } from "./rga";
import { UndoManager } from "./undo";

it("undo/redo a typing burst as one step", () => {
  const rga = new Rga("a".repeat(16));
  const u = new UndoManager(rga, 500);
  u.record(rga.insert(0, "h"), 0);
  u.record(rga.insert(1, "i"), 100);
  expect(u.undo()!.caret).toBe(0);
  expect(rga.text()).toBe("");
  expect(u.redo()!.caret).toBe(2);
  expect(rga.text()).toBe("hi");
});

it("a pause starts a new step", () => {
  const rga = new Rga("a".repeat(16));
  const u = new UndoManager(rga, 500);
  u.record(rga.insert(0, "a"), 0);
  u.record(rga.insert(1, "b"), 1000);
  u.undo();
  expect(rga.text()).toBe("a");
});

it("undoing a delete restores exactly those characters", () => {
  const rga = new Rga("a".repeat(16));
  const u = new UndoManager(rga);
  u.record(rga.insert(0, "hello"), 0);
  u.breakGroup();
  u.record(rga.delete(1, 3)!, 1000);
  expect(rga.text()).toBe("ho");
  expect(u.undo()!.caret).toBe(4);
  expect(rga.text()).toBe("hello");
});

it("never touches a collaborator's text, even in the same line", () => {
  const me = new Rga("a".repeat(16));
  const friend = new Rga("b".repeat(16));
  const u = new UndoManager(me);
  const mine = me.insert(0, "mine ");
  u.record(mine, 0);
  friend.apply(mine);
  const theirs = friend.insert(5, "theirs");
  me.apply(theirs);
  const res = u.undo()!;
  for (const op of res.ops) friend.apply(op);
  expect(me.text()).toBe("theirs");
  expect(friend.text()).toBe("theirs");
});

it("undo revives text a collaborator also deleted", () => {
  const me = new Rga("a".repeat(16));
  const friend = new Rga("b".repeat(16));
  const u = new UndoManager(me);
  const ins = me.insert(0, "keep");
  friend.apply(ins);
  u.breakGroup();
  const del = me.delete(0, 4)!;
  u.record(del, 1000);
  friend.apply(del);
  const friendDel = friend.deleteIds([{ r: "a".repeat(16), c: 1, n: 4 }]); // friend deletes them too…
  me.apply(friendDel); // …and I see it before undoing
  const res = u.undo()!;
  for (const op of res.ops) friend.apply(op); // my later stamp wins (LWW)
  expect(me.text()).toBe("keep");
  expect(friend.text()).toBe("keep");
});

it("a new edit clears redo", () => {
  const rga = new Rga("a".repeat(16));
  const u = new UndoManager(rga);
  u.record(rga.insert(0, "a"), 0);
  u.undo();
  u.record(rga.insert(0, "b"), 2000);
  expect(u.redo()).toBeNull();
});

it("undo with nothing recorded returns null", () => {
  expect(new UndoManager(new Rga("a".repeat(16))).undo()).toBeNull();
});
