/**
 * Note names live in the URL fragment (`/#/<name>`) because browsers never send the
 * fragment to the server: the name is the key, so the server must never see it.
 * An old-style `/<name>` link still works — it is moved into the fragment on load —
 * but that first request did reach the server, so share `/#/` links.
 */
export function legacyPathToHash(pathname: string, search: string, hash: string): string | null {
  if (pathname === "/" || hash !== "") return null;
  return `/#${pathname}${search}`;
}
