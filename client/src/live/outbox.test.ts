import { expect, it } from "vitest";
import { memoryStorage } from "../notes/pending";
import { createOutbox } from "./outbox";

const ID = "a".repeat(43);

it("adds, lists in order, removes by cid; stores only ct/iv/cid", () => {
  const storage = memoryStorage();
  const ob = createOutbox(storage);
  ob.add(ID, { cid: "1", ct: "Y3Q=", iv: "aXY=" });
  ob.add(ID, { cid: "2", ct: "Y3Q=", iv: "aXY=" });
  ob.remove(ID, "1");
  expect(ob.list(ID).map((i) => i.cid)).toEqual(["2"]);
  expect(JSON.parse(storage.getItem(`outbox:${ID}`)!)).toEqual([{ cid: "2", ct: "Y3Q=", iv: "aXY=" }]);
});

it("corrupt storage reads as empty", () => {
  const storage = memoryStorage();
  storage.setItem(`outbox:${ID}`, "{nope");
  expect(createOutbox(storage).list(ID)).toEqual([]);
});

it("removing the last item clears the key", () => {
  const storage = memoryStorage();
  const ob = createOutbox(storage);
  ob.add(ID, { cid: "1", ct: "Y3Q=", iv: "aXY=" });
  ob.remove(ID, "1");
  expect(storage.getItem(`outbox:${ID}`)).toBeNull();
});
