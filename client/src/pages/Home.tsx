import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { estimateStrength, generateName, normalizeName } from "../names/names";

export default function Home() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const normalized = normalizeName(name);
  const strength = normalized ? estimateStrength(normalized) : null;

  const open = (e: FormEvent) => {
    e.preventDefault();
    if (normalized) navigate(`/${encodeURIComponent(normalized)}`);
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold">shribe2e</h1>
      <p className="text-sm">
        Pick a name. The name is the key: anyone who knows it can read and edit the note, and the server never
        learns it.
      </p>
      <form onSubmit={open} className="flex gap-2">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="note name"
          aria-label="note name"
          className="flex-1 border p-2 font-mono"
        />
        <button type="submit" className="border px-3" disabled={!normalized}>
          open
        </button>
      </form>
      <button type="button" onClick={() => setName(generateName())} className="self-start text-sm underline">
        generate one
      </button>
      {strength && (
        <p className="text-sm" data-level={strength.level}>
          {strength.message} (~{strength.bits} bits)
        </p>
      )}
    </main>
  );
}
