import { describe, expect, it } from "vitest";
import { copyText } from "./copyText";

describe("copyText", () => {
  it("writes the whole text and reports copied", async () => {
    let written = "";
    const clipboard = { writeText: async (t: string) => void (written = t) };
    expect(await copyText("hello\nworld", clipboard)).toBe("copied");
    expect(written).toBe("hello\nworld");
  });

  it("reports failure when the browser refuses", async () => {
    const clipboard = { writeText: () => Promise.reject(new Error("denied")) };
    expect(await copyText("x", clipboard)).toBe("copy failed");
  });

  it("reports failure when there is no clipboard (insecure context)", async () => {
    expect(await copyText("x", undefined)).toBe("copy failed");
  });
});
