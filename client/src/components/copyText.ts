export type CopyResult = "copied" | "copy failed";

/** navigator.clipboard is missing outside secure contexts (plain http), so the caller passes it in. */
export async function copyText(
  text: string,
  clipboard: Pick<Clipboard, "writeText"> | undefined,
): Promise<CopyResult> {
  if (!clipboard) return "copy failed";
  try {
    await clipboard.writeText(text);
    return "copied";
  } catch {
    return "copy failed";
  }
}
