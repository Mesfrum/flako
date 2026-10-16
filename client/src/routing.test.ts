import { describe, expect, it } from "vitest";
import { legacyPathToHash } from "./routing";

describe("legacyPathToHash", () => {
  it("moves an old-style /name path into the fragment", () => {
    expect(legacyPathToHash("/taco", "", "")).toBe("/#/taco");
  });

  it("keeps encoded names and nested paths intact", () => {
    expect(legacyPathToHash("/my%20notes/work", "", "")).toBe("/#/my%20notes/work");
  });

  it("leaves the root and already-hashed URLs alone", () => {
    expect(legacyPathToHash("/", "", "")).toBeNull();
    expect(legacyPathToHash("/", "", "#/taco")).toBeNull();
  });
});
