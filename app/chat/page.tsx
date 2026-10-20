"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  streamTurn,
  toTurns,
  type ApiMessage,
  type ContentBlock,
  type SystemBlock,
  type TurnEvent,
  type Usage,
} from "@/lib/anthropic";
import { COMPACT_THRESHOLD_TOKENS } from "@/lib/config";
import { buildSystem, compactConversation, contextSize, splitForCompaction } from "@/lib/context";
import {
  addMessage,
  createConversation,
  createProject,
  getApiKey,
  getFileBlob,
  getMessages,
  getModel,
  listConversations,
  listProjects,
  saveFile,
  touchConversation,
  updateConversationSummary,
  updateProjectContext,
  type Conversation,
  type Message,
  type Project,
  type StoredFileMeta,
} from "@/lib/db";
import { CREATE_XLSX_TOOL, MAX_TOOL_STEPS, XLSX_GUIDANCE, runCreateXlsx } from "@/lib/xlsx/tool";
import { requestPersistence } from "@/lib/persist";

const fmt = (n: number) => n.toLocaleString("uk-UA");
const fmtSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} Б` : `${Math.round(bytes / 1024)} КБ`;

export default function ChatPage() {
  const router = useRouter();
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConv, setActiveConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [streamText, setStreamText] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [contextDraft, setContextDraft] = useState("");
  const [newProjectName, setNewProjectName] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;
  const lastUsage: Usage | undefined = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.usage)?.usage;

  useEffect(() => {
    void requestPersistence();
    let cancelled = false;

    (async () => {
      const key = await getApiKey();
      if (!key) {
        router.replace("/setup");
        return;
      }
      const [projectList, allConversations] = await Promise.all([
        listProjects(),
        listConversations(),
      ]);
      const latest = allConversations[0] ?? null;
      const latestMessages = latest ? await getMessages(latest.id) : [];
      if (cancelled) return;

      const projectId = latest?.projectId ?? null;
      setApiKey(key);
      setProjects(projectList);
      setSelectedProjectId(projectId);
      setContextDraft(projectList.find((p) => p.id === projectId)?.pinnedContext ?? "");
      setConversations(
        latest ? allConversations.filter((c) => c.projectId === projectId) : []
      );
      if (latest) {
        setActiveConv(latest);
        setMessages(latestMessages);
      }
    })().catch(() => router.replace("/setup"));

    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streamText, status]);

  async function refreshConversations(projectId: string | null) {
    setConversations(await listConversations(projectId));
  }

  async function selectProject(id: string | null) {
    if (busy) return;
    setSelectedProjectId(id);
    setContextDraft(projects.find((p) => p.id === id)?.pinnedContext ?? "");
    setActiveConv(null);
    setMessages([]);
    setError(null);
    await refreshConversations(id);
  }

  async function openConversation(conv: Conversation) {
    if (busy) return;
    setActiveConv(conv);
    setSelectedProjectId(conv.projectId);
    setContextDraft(projects.find((p) => p.id === conv.projectId)?.pinnedContext ?? "");
    setMessages(await getMessages(conv.id));
    await refreshConversations(conv.projectId);
    setError(null);
    setListOpen(false);
  }

  function newChat() {
    if (busy) return;
    setActiveConv(null);
    setMessages([]);
    setError(null);
    setListOpen(false);
  }

  async function createProjectHandler() {
    const name = newProjectName.trim();
    if (!name || busy) return;
    const project = await createProject(name);
    setProjects(await listProjects());
    setNewProjectName("");
    setSelectedProjectId(project.id);
    setContextDraft("");
    setActiveConv(null);
    setMessages([]);
    await refreshConversations(project.id);
  }

  async function saveContext() {
    if (!selectedProject) return;
    await updateProjectContext(selectedProject.id, contextDraft);
    setProjects(await listProjects());
  }

  function stop() {
    abortRef.current?.abort();
  }

  async function downloadFile(file: StoredFileMeta) {
    const blob = await getFileBlob(file.id);
    if (!blob) {
      setError("Файл більше недоступний. Попросіть створити його знову.");
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function send(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || busy || !apiKey) return;

    setBusy(true);
    setError(null);
    setDraft("");

    try {
      const model = await getModel();
      let conv = activeConv;
      if (!conv) {
        conv = await createConversation(text.slice(0, 60), selectedProjectId);
        setActiveConv(conv);
      }

      // Стиснення: коли розмір контексту з останньої відповіді перевищує поріг.
      if (contextSize(lastUsage) > COMPACT_THRESHOLD_TOKENS) {
        const split = splitForCompaction(messages, conv.summaryCutoff);
        if (split) {
          setStatus("Стискаємо розмову…");
          const summary = await compactConversation({
            apiKey,
            model,
            summary: conv.summary ?? null,
            toSummarize: split.toSummarize,
          });
          await updateConversationSummary(conv.id, summary, split.cutoffAt);
          conv = { ...conv, summary, summaryCutoff: split.cutoffAt };
          setActiveConv(conv);
          setStatus(null);
        }
      }

      const project = selectedProject;
      const userMessage = await addMessage(conv.id, "user", text);
      const visible = [...messages, userMessage];
      setMessages(visible);

      const cutoff = conv.summaryCutoff ?? 0;
      const apiMessages: ApiMessage[] = toTurns(visible.filter((m) => m.createdAt > cutoff));
      const system: SystemBlock[] = [
        { type: "text", text: XLSX_GUIDANCE },
        ...buildSystem(project, conv.summary ?? null),
      ];

      const controller = new AbortController();
      abortRef.current = controller;
      let fullText = "";
      let usage: Usage | undefined;
      const produced: { name: string; blob: Blob }[] = [];
      setStreamText("");

      // Цикл ходів: якщо модель викликає create_xlsx, застосунок створює файл і повертає результат.
      for (let step = 0; ; step++) {
        let turn: Extract<TurnEvent, { type: "done" }> | null = null;
        for await (const ev of streamTurn({
          apiKey,
          model,
          system,
          messages: apiMessages,
          tools: [CREATE_XLSX_TOOL],
          signal: controller.signal,
        })) {
          if (ev.type === "text") {
            fullText += ev.text;
            setStreamText(fullText);
          } else {
            turn = ev;
          }
        }
        if (!turn) break; // перервано користувачем

        usage = turn.usage;
        const toolUses = turn.content.filter(
          (block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use"
        );
        if (turn.stopReason !== "tool_use" || toolUses.length === 0 || step >= MAX_TOOL_STEPS) break;

        apiMessages.push({ role: "assistant", content: turn.content });
        setStatus("Створюємо файл…");
        const results: ContentBlock[] = [];
        for (const tool of toolUses) {
          const run = await runCreateXlsx(tool.input);
          if (run.ok) {
            produced.push({ name: run.name, blob: run.blob });
            results.push({ type: "tool_result", tool_use_id: tool.id, content: run.summary });
          } else {
            results.push({
              type: "tool_result",
              tool_use_id: tool.id,
              content: run.error,
              is_error: true,
            });
          }
        }
        apiMessages.push({ role: "user", content: results });
        setStatus(null);
      }

      setStreamText(null);
      setStatus(null);

      const replyText =
        fullText.trim() ||
        (produced.length > 0 ? `Створено файл: ${produced.map((f) => f.name).join(", ")}` : "");
      if (replyText) {
        const files: StoredFileMeta[] = [];
        for (const f of produced) files.push(await saveFile(f.name, f.blob));
        const reply = await addMessage(conv.id, "assistant", replyText, usage, files);
        setMessages((prev) => [...prev, reply]);
      }
      await touchConversation(conv.id);
      await refreshConversations(selectedProjectId);
    } catch (err) {
      setStreamText(null);
      setStatus(null);
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
        <select
          className="btn select"
          value={selectedProjectId ?? ""}
          onChange={(e) => void selectProject(e.target.value || null)}
          disabled={busy}
          aria-label="Проєкт"
        >
          <option value="">Без проєкту</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="btn" type="button" onClick={newChat} disabled={busy}>
          Нова
        </button>
      </header>

      {lastUsage && (
        <p className="meter" aria-live="polite">
          Контекст: {fmt(contextSize(lastUsage))} токенів. Вхід{" "}
          {fmt(lastUsage.input + lastUsage.cacheWrite + lastUsage.cacheRead)}, з кешу{" "}
          {fmt(lastUsage.cacheRead)}, відповідь {fmt(lastUsage.output)}.
          {activeConv?.summary ? " Частину розмови стиснуто." : ""}
        </p>
      )}

      {listOpen && (
        <section className="raised panel stack-sm" aria-label="Розмови і проєкти">
          <h2 className="section-title">
            {selectedProject ? selectedProject.name : "Без проєкту"}
          </h2>
          {conversations.length === 0 ? (
            <p className="muted">Розмов ще немає.</p>
          ) : (
            <ul className="list">
              {conversations.map((c) => (
                <li key={c.id}>
                  <button
                    className="link"
                    type="button"
                    onClick={() => void openConversation(c)}
                    disabled={busy}
                  >
                    {c.title}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {selectedProject && (
            <div className="stack-sm">
              <label className="muted" htmlFor="pinned">
                Закріплений контекст
              </label>
              <textarea
                id="pinned"
                className="inset"
                rows={5}
                value={contextDraft}
                onChange={(e) => setContextDraft(e.target.value)}
                placeholder="Опишіть проєкт, правила і терміни. Модель враховує це в кожній розмові проєкту."
              />
              <button
                className="btn"
                type="button"
                onClick={() => void saveContext()}
                disabled={contextDraft === selectedProject.pinnedContext}
              >
                Зберегти контекст
              </button>
            </div>
          )}

          <div className="stack-sm">
            <label className="muted" htmlFor="new-project">
              Новий проєкт
            </label>
            <div className="row">
              <input
                id="new-project"
                className="inset"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="Назва"
              />
              <button
                className="btn"
                type="button"
                onClick={() => void createProjectHandler()}
                disabled={!newProjectName.trim() || busy}
              >
                Створити
              </button>
            </div>
          </div>
        </section>
      )}

      <div className="messages" role="log" aria-live="polite">
        {messages.length === 0 && streamText === null && !status && (
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
              {m.files && m.files.length > 0 && (
                <div className="file-list">
                  {m.files.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className="file-card"
                      onClick={() => void downloadFile(f)}
                    >
                      <span className="file-name">{f.name}</span>
                      <span className="file-meta">Excel · {fmtSize(f.size)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        )}
        {status && <p className="status">{status}</p>}
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
