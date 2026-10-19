"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { validateApiKey } from "@/lib/anthropic";
import { saveApiKey } from "@/lib/db";

export default function SetupPage() {
  const router = useRouter();
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = apiKey.trim();
    if (!key || busy) return;

    setBusy(true);
    setError(null);
    try {
      await validateApiKey(key);
      await saveApiKey(key);
      router.replace("/chat");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не вдалося перевірити ключ.");
      setBusy(false);
    }
  }

  return (
    <main className="screen">
      <section className="raised card">
        <h1>Ключ Anthropic</h1>
        <p className="muted">
          Ключ зберігається тільки на цьому пристрої і надсилається лише до api.anthropic.com.
        </p>

        <form className="stack" onSubmit={onSubmit}>
          <label className="muted" htmlFor="api-key">
            API-ключ
          </label>
          <input
            id="api-key"
            className="inset"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="sk-ant-..."
            required
          />
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-primary" type="submit" disabled={busy || !apiKey.trim()}>
            {busy ? "Перевіряємо ключ…" : "Перевірити і зберегти"}
          </button>
        </form>
      </section>
    </main>
  );
}
