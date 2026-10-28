import { useEffect, useState } from "react";
import { effectiveTheme, readTheme, writeTheme, type Theme } from "./theme";

const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

// Merely touching window.localStorage throws when site data is blocked.
const noStorage = { getItem: () => null, setItem: () => {} };
function storage() {
  try {
    return window.localStorage;
  } catch {
    return noStorage;
  }
}

/** A quiet sun/moon button. Follows the system until clicked; then the choice sticks. */
export function ThemeToggle() {
  const [stored, setStored] = useState<Theme | null>(() => readTheme(storage()));
  const [systemDark, setSystemDark] = useState(() => darkQuery().matches);

  useEffect(() => {
    const q = darkQuery();
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    q.addEventListener("change", onChange);
    return () => q.removeEventListener("change", onChange);
  }, []);

  const theme = effectiveTheme(stored, systemDark);

  useEffect(() => {
    if (stored) document.documentElement.dataset.theme = stored;
  }, [stored]);

  const next: Theme = theme === "dark" ? "light" : "dark";
  const toggle = () => {
    writeTheme(storage(), next);
    setStored(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className="grid size-9 place-items-center rounded-box text-muted transition-colors hover:bg-raised hover:text-ink"
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

const iconProps = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function SunIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg {...iconProps}>
      <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" />
    </svg>
  );
}
