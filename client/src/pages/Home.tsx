import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { noteKeys } from "../crypto/keyCache";
import { ThemeToggle } from "../theme/ThemeToggle";
import { estimateStrength, generateName, normalizeName, type StrengthLevel } from "../names/names";

// Wait for a typing pause before spending ~0.5 s and 64 MiB on a name.
const PREFETCH_PAUSE_MS = 300;

const LEVEL_DOT: Record<StrengthLevel, string> = {
  weak: "bg-negative",
  fair: "bg-warning",
  strong: "bg-positive",
};

export default function Home() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const normalized = normalizeName(name);
  const strength = normalized ? estimateStrength(normalized) : null;

  // Derive the key while the name is still being typed, so opening the note is instant.
  useEffect(() => {
    if (!normalized) return;
    const t = setTimeout(() => noteKeys.prefetch(normalized), PREFETCH_PAUSE_MS);
    return () => clearTimeout(t);
  }, [normalized]);

  const generate = () => {
    const next = generateName();
    setName(next);
    noteKeys.prefetch(normalizeName(next)); // no typing pause to wait for
  };

  const open = (e: FormEvent) => {
    e.preventDefault();
    if (normalized) navigate(`/${encodeURIComponent(normalized)}`);
  };

  return (
    <div className="flex min-h-dvh flex-col px-4 sm:px-8">
      <header className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between">
        <span className="text-[15px] font-semibold tracking-tight">flako</span>
        <ThemeToggle />
      </header>

      <main className="mx-auto grid w-full max-w-5xl flex-1 content-center gap-x-16 gap-y-14 py-12 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-center">
        <div className="max-w-2xl">
          <h1 className="text-[32px] leading-[1.1] font-semibold tracking-[-0.02em] text-balance sm:text-[44px]">
            Encrypted notes, opened by name
          </h1>
          <p className="mt-4 max-w-xl text-[17px] leading-relaxed">
            The name is the key. Anyone who knows it can read and edit the note with you; the server only ever stores
            scrambled bytes.
          </p>

          <form onSubmit={open} className="mt-10">
            <label htmlFor="note-name" className="text-sm font-medium">
              Note name
            </label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input
                id="note-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. tidal-quiet-orchard-lamp"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-describedby="name-strength"
                className="h-13 w-full min-w-0 rounded-box sm:flex-1 border border-control bg-surface px-4 text-lg placeholder:text-muted"
              />
              <button
                type="submit"
                disabled={!normalized}
                className="h-13 rounded-box bg-primary px-7 text-base font-medium text-on-primary transition-[transform,opacity] active:scale-[0.98] disabled:opacity-35"
              >
                Open note
              </button>
            </div>

            <div className="mt-3 flex min-h-11 flex-wrap items-center gap-x-4 gap-y-2">
              <button
                type="button"
                onClick={generate}
                className="h-9 rounded-box bg-raised px-3.5 text-sm font-medium transition-[transform,background-color] hover:bg-line active:scale-[0.98]"
              >
                Generate a strong name
              </button>
              <p id="name-strength" aria-live="polite" className="flex items-center gap-2 text-sm">
                {strength && (
                  <>
                    <span aria-hidden className={`size-2 shrink-0 rounded-full ${LEVEL_DOT[strength.level]}`} />
                    <span>{capitalize(strength.message)}</span>
                  </>
                )}
              </p>
            </div>
          </form>
        </div>

        <section aria-labelledby="how" className="rounded-box bg-surface p-6">
          <h2 id="how" className="sr-only">
            How flako works
          </h2>
          <dl className="grid gap-6 text-[15px] leading-relaxed">
            <Fact term="Nothing readable leaves your browser">
              The name becomes an AES-256 key on your device (Argon2id, then HKDF). The server stores ciphertext under a
              hash of the name and never sees the name or your words.
            </Fact>
            <Fact term="Write together, live">
              Share the name and edit at the same time. Everyone’s cursor shows in its own colour.
            </Fact>
            <Fact term="Keeps working offline">
              Edits made without a connection wait in your browser and merge in when you’re back.
            </Fact>
          </dl>
        </section>
      </main>
    </div>
  );
}

function Fact({ term, children }: { term: string; children: string }) {
  return (
    <div>
      <dt className="font-medium">{term}</dt>
      <dd className="mt-1 text-muted">{children}</dd>
    </div>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
