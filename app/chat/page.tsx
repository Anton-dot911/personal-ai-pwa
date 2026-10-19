"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { streamMessage, toTurns } from "@/lib/anthropic";
import {
  addMessage,
  createConversation,
  getApiKey,
  getMessages,
  getModel,
  listConversations,
  touchConversation,
  type Conversation,
  type Message,
} from "@/lib/db";
import { requestPersistence } from "@/lib/persist";

export default function ChatPage() {
  const router = useRouter();
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [streamText, setStreamText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  // Запит на збереження даних і відкриття останньої розмови після перезавантаження.
  useEffect(() => {
    void requestPersistence();
    let cancelled = false;

    (async () => {
      const key = await getApiKey();
      if (!key) {
        router.replace("/setup");
        return;
      }
      const list = await listConversations();
      const latest = list[0];
      const latestMessages = latest ? await getMessages(latest.id) : [];
      if (cancelled) return;
      setApiKey(key);
      setConversations(list);
      if (latest) {
        setActiveId(latest.id);
        setMessages(latestMessages);
      }
    })().catch(() => router.replace("/setup"));

    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streamText]);

  async function openConversation(id: string) {
    setActiveId(id);
    setMessages(await getMessages(id));
    setError(null);
    setListOpen(false);
  }

  function newChat() {
    setActiveId(null);
    setMessages([]);
    setError(null);
    setListOpen(false);
  }

  function stop() {
    abortRef.current?.abort();
  }

  async function send(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || busy || !apiKey) return;

    setBusy(true);
    setError(null);
    setDraft("");

    try {
      let conversationId = activeId;
      if (!conversationId) {
        const conversation = await createConversation(text.slice(0, 60));
        conversationId = conversation.id;
        setActiveId(conversation.id);
      }

      const userMessage = await addMessage(conversationId, "user", text);
      const history = [...messages, userMessage];
      setMessages(history);

      const controller = new AbortController();
      abortRef.current = controller;
      const model = await getModel();

      let full = "";
      setStreamText("");
      for await (const chunk of streamMessage({
        apiKey,
        model,
        messages: toTurns(history),
        signal: controller.signal,
      })) {
        full += chunk;
        setStreamText(full);
      }
      setStreamText(null);

      if (full) {
        const reply = await addMessage(conversationId, "assistant", full);
        setMessages((prev) => [...prev, reply]);
      }
      await touchConversation(conversationId);
      setConversations(await listConversations());
    } catch (err) {
      setStreamText(null);
      setError(
        err instanceof Error ? err.message : "Не вдалося надіслати повідомлення. Спробуйте ще раз."
      );
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  return (
    <main className="screen">
      <header className="topbar">
        <button
          className="btn"
          type="button"
          onClick={() => setListOpen((open) => !open)}
          aria-expanded={listOpen}
        >
          Розмови
        </button>
        <button className="btn" type="button" onClick={newChat} disabled={busy}>
          Нова
        </button>
      </header>

      {listOpen && (
        <section className="raised panel" aria-label="Список розмов">
          {conversations.length === 0 ? (
            <p className="muted">Розмов ще немає.</p>
          ) : (
            <ul className="list">
              {conversations.map((c) => (
                <li key={c.id}>
                  <button
                    className="link"
                    type="button"
                    onClick={() => openConversation(c.id)}
                    disabled={busy}
                  >
                    {c.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="messages" role="log" aria-live="polite">
        {messages.length === 0 && streamText === null && (
          <p className="muted empty">Напишіть повідомлення, щоб почати розмову.</p>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="msg-user raised">
              {m.content}
            </div>
          ) : (
            <div key={m.id} className="msg-assistant">
              {m.content}
            </div>
          )
        )}
        {streamText !== null && <div className="msg-assistant">{streamText || "…"}</div>}
        <div ref={endRef} />
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <form className="composer" onSubmit={send}>
        <textarea
          className="inset"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Повідомлення"
          aria-label="Повідомлення"
          rows={1}
        />
        {busy ? (
          <button className="btn" type="button" onClick={stop}>
            Зупинити
          </button>
        ) : (
          <button className="btn btn-primary" type="submit" disabled={!draft.trim()}>
            Надіслати
          </button>
        )}
      </form>
    </main>
  );
}
