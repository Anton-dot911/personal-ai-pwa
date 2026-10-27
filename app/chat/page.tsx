"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  listModels,
  streamTurn,
  type ApiMessage,
  type ContentBlock,
  type ModelInfo,
  type SystemBlock,
  type TurnEvent,
  type Usage,
} from "@/lib/anthropic";
import { COMPACT_THRESHOLD_TOKENS, DEFAULT_MODEL } from "@/lib/config";
import { buildSystem, compactConversation, contextSize, splitForCompaction, toApiHistory } from "@/lib/context";
import {
  addMessage,
  createConversation,
  createProject,
  deleteConversation,
  deleteProject,
  getAllowedDomains,
  getApiKey,
  getFileBlob,
  getMessages,
  listConversations,
  listProjects,
  saveFile,
  setAllowedDomains,
  setConversationModel,
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
import { WEB_GUIDANCE, buildWebFetchTool, parseDomains } from "@/lib/web";
import type { ToolParam } from "@/lib/anthropic";
import type { DiffEntry } from "@/lib/xlsx/fill";
import { FILL_XLSX_TOOL, describeUpload, runFillXlsx } from "@/lib/xlsx/fill-tool";
import { backupFilename, buildBackup, restoreBackup } from "@/lib/backup";

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
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [newChatModel, setNewChatModel] = useState<string>(DEFAULT_MODEL);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ kind: "conversation" | "project"; id: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [domainsDraft, setDomainsDraft] = useState("");
  const [upload, setUpload] = useState<{ name: string; buffer: ArrayBuffer; summary: string } | null>(null);
  const [fillResult, setFillResult] = useState<{ name: string; blob: Blob; diff: DiffEntry[] } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;
  const lastUsage: Usage | undefined = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.usage)?.usage;
  // Модель поточної розмови, а для нової розмови та її вибір на початку.
  // Стара розмова без збереженої моделі використовує модель за замовчуванням, як і під час запиту.
  const currentModel = activeConv ? activeConv.model ?? DEFAULT_MODEL : newChatModel;
  const modelOptions: ModelInfo[] = (models.length > 0 ? models : []).slice();
  if (!modelOptions.some((m) => m.id === currentModel)) {
    modelOptions.unshift({ id: currentModel, displayName: currentModel });
  }

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
      void getAllowedDomains().then((d) => setDomainsDraft(d.join("\n")));
      setConversations(
        latest ? allConversations.filter((c) => c.projectId === projectId) : []
      );
      if (latest) {
        setActiveConv(latest);
        setMessages(latestMessages);
      }
    })().catch((err) =>
      setError(
        `Не вдалося прочитати збережені дані: ${err instanceof Error ? err.message : "невідома помилка"}`
      )
    );

    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (!apiKey) return;
    listModels(apiKey)
      .then((list) => {
        setModels(list);
        setModelsError(null);
      })
      .catch((err) =>
        setModelsError(
          err instanceof Error
            ? `${err.message} Доступна модель за замовчуванням.`
            : "Не вдалося отримати список моделей."
        )
      );
  }, [apiKey]);

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

  // Для поточної розмови модель зберігається в ній. Для нової розмови запам'ятовується вибір.
  async function changeModel(id: string) {
    if (busy) return;
    if (!activeConv) {
      setNewChatModel(id);
      return;
    }
    await setConversationModel(activeConv.id, id);
    setActiveConv({ ...activeConv, model: id });
    await refreshConversations(selectedProjectId);
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

  // Системне меню iOS: «Зберегти в Файли», відкриття в Numbers чи Excel тощо.
  async function shareFile(file: StoredFileMeta) {
    const blob = await getFileBlob(file.id);
    if (!blob) {
      setError("Файл більше недоступний. Попросіть створити його знову.");
      return;
    }
    const data = new File([blob], file.name, {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    if (typeof navigator !== "undefined" && navigator.share && navigator.canShare?.({ files: [data] })) {
      try {
        await navigator.share({ files: [data], title: file.name });
      } catch (err) {
        // Скасування користувачем не є помилкою.
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setError("Не вдалося поділитися файлом. Спробуйте «Зберегти».");
        }
      }
      return;
    }
    await downloadFile(file);
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

  async function deleteConversationById(id: string) {
    if (busy) return;
    try {
      await deleteConversation(id);
      if (activeConv?.id === id) {
        setActiveConv(null);
        setMessages([]);
      }
      setConfirmDelete(null);
      await refreshConversations(selectedProjectId);
      setNotice("Розмову видалено.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не вдалося видалити розмову.");
    }
  }

  async function deleteProjectById(id: string) {
    if (busy) return;
    try {
      await deleteProject(id);
      setProjects(await listProjects());
      setSelectedProjectId(null);
      setContextDraft("");
      setActiveConv(null);
      setMessages([]);
      setConfirmDelete(null);
      await refreshConversations(null);
      setNotice("Проєкт і його розмови видалено.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не вдалося видалити проєкт.");
    }
  }

  async function saveDomains() {
    const { domains, invalid } = parseDomains(domainsDraft);
    if (invalid.length > 0) {
      setError(`Некоректні домени: ${invalid.join(", ")}`);
      return;
    }
    await setAllowedDomains(domains);
    setDomainsDraft(domains.join("\n"));
    setNotice(domains.length > 0 ? `Дозволено сайтів: ${domains.length}.` : "Відкриття сайтів вимкнено.");
  }

  async function onUpload(file: File | undefined) {
    if (!file || busy) return;
    try {
      const buffer = await file.arrayBuffer();
      const { inspectXlsx } = await import("@/lib/xlsx/fill");
      const info = await inspectXlsx(buffer);
      setUpload({ name: file.name, buffer, summary: describeUpload(file.name, info) });
      setFillResult(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не вдалося прочитати таблицю.");
    }
  }

  // Файл з змінами створюється тільки після підтвердження користувачем.
  async function confirmFill() {
    if (!fillResult || !activeConv || busy) return;
    try {
      const meta = await saveFile(fillResult.name, fillResult.blob);
      const reply = await addMessage(
        activeConv.id,
        "assistant",
        `Файл з підтвердженими змінами: ${fillResult.name}`,
        undefined,
        [meta],
        {
          source: "app",
          actions: [`Файл створено після підтвердження: ${fillResult.name}`],
        }
      );
      setMessages((prev) => [...prev, reply]);
      setFillResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не вдалося зберегти файл.");
    }
  }

  async function exportBackup() {
    try {
      const data = await buildBackup();
      const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = backupFilename();
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setBackupMessage(
        `Копію збережено: розмов ${data.conversations.length}, повідомлень ${data.messages.length}.`
      );
    } catch (err) {
      setBackupMessage(err instanceof Error ? err.message : "Не вдалося зберегти копію.");
    }
  }

  async function restoreFromFile(file: File | undefined) {
    if (!file || busy) return;
    try {
      const text = await file.text();
      const result = await restoreBackup(text);
      setProjects(await listProjects());
      setSelectedProjectId(null);
      setActiveConv(null);
      setMessages([]);
      await refreshConversations(null);
      setBackupMessage(
        `Відновлено: проєктів ${result.projects}, розмов ${result.conversations}, повідомлень ${result.messages}.`
      );
    } catch (err) {
      setBackupMessage(err instanceof Error ? err.message : "Не вдалося відновити копію.");
    }
  }

  async function send(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || busy || !apiKey) return;

    setBusy(true);
    setError(null);
    setDraft("");

    try {
      let conv = activeConv;
      if (!conv) {
        conv = await createConversation(text.slice(0, 60), selectedProjectId, currentModel);
        setActiveConv(conv);
      }
      const model = conv.model ?? DEFAULT_MODEL;

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
      const apiMessages: ApiMessage[] = toApiHistory(visible.filter((m) => m.createdAt > cutoff));
      const allowedDomains = await getAllowedDomains();
      const webTool = buildWebFetchTool(allowedDomains);
      const tools: ToolParam[] = [
        ...(upload ? [CREATE_XLSX_TOOL, FILL_XLSX_TOOL] : [CREATE_XLSX_TOOL]),
        ...(webTool ? [webTool] : []),
      ];
      const system: SystemBlock[] = [
        { type: "text", text: XLSX_GUIDANCE },
        ...(upload ? [{ type: "text" as const, text: upload.summary }] : []),
        ...(webTool ? [{ type: "text" as const, text: WEB_GUIDANCE }] : []),
        ...buildSystem(project, conv.summary ?? null),
      ];

      const controller = new AbortController();
      abortRef.current = controller;
      let fullText = "";
      let usage: Usage | undefined;
      const produced: { name: string; blob: Blob }[] = [];
      setStreamText("");

      let fillOutcome: { name: string; blob: Blob; diff: DiffEntry[] } | null = null;
      const turnLog: ApiMessage[] = [];
      const actions: string[] = [];
      let finalContent: ContentBlock[] = [];
      let finalStop: string | null = null;

      // Цикл ходів: якщо модель викликає create_xlsx, застосунок створює файл і повертає результат.
      for (let step = 0; ; step++) {
        let turn: Extract<TurnEvent, { type: "done" }> | null = null;
        for await (const ev of streamTurn({
          apiKey,
          model,
          system,
          messages: apiMessages,
          tools,
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
        finalContent = turn.content;
        const toolUses = turn.content.filter(
          (block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use"
        );
        finalStop = turn.stopReason;
        // Відкриті сторінки записуємо в журнал дій з реальних результатів сервера.
        const urlById = new Map<string, string>();
        for (const block of turn.content) {
          if (block.type === "server_tool_use") {
            const url = (block.input as { url?: unknown } | null)?.url;
            if (typeof url === "string") urlById.set(block.id, url);
          }
        }
        for (const block of turn.content) {
          if (block.type !== "web_fetch_tool_result") continue;
          const result = block.content as { type?: string; url?: string; error_code?: string };
          const url = result.url ?? urlById.get(block.tool_use_id) ?? "посилання";
          actions.push(
            result.type === "web_fetch_tool_result_error"
              ? `Не вдалося відкрити ${url}: ${result.error_code ?? "помилка"}`
              : `Відкрито: ${url}`
          );
        }
        // Пауза серверного інструмента: продовжуємо той самий хід без нового повідомлення користувача.
        if (turn.stopReason === "pause_turn" && step < MAX_TOOL_STEPS) {
          apiMessages.push({ role: "assistant", content: turn.content });
          turnLog.push({ role: "assistant", content: turn.content });
          continue;
        }
        if (turn.stopReason !== "tool_use" || toolUses.length === 0 || step >= MAX_TOOL_STEPS) break;

        apiMessages.push({ role: "assistant", content: turn.content });
        turnLog.push({ role: "assistant", content: turn.content });
        setStatus("Створюємо файл…");
        const results: ContentBlock[] = [];
        for (const tool of toolUses) {
          if (tool.name === "fill_xlsx" && upload) {
            const fill = await runFillXlsx(tool.input, upload.buffer);
            if (fill.ok) {
              const base = upload.name.replace(/\.xlsx$/i, "");
              fillOutcome = { name: `${base}_змінено.xlsx`, blob: fill.blob, diff: fill.diff };
              actions.push(`Підготовлено змін: ${fill.diff.length}, файл створиться після підтвердження`);
              results.push({ type: "tool_result", tool_use_id: tool.id, content: fill.summary });
            } else {
              actions.push(`Помилка заповнення: ${fill.error}`);
              results.push({ type: "tool_result", tool_use_id: tool.id, content: fill.error, is_error: true });
            }
            continue;
          }
          const run = await runCreateXlsx(tool.input);
          if (run.ok) {
            produced.push({ name: run.name, blob: run.blob });
            actions.push(`Створено файл «${run.name}»`);
            results.push({ type: "tool_result", tool_use_id: tool.id, content: run.summary });
          } else {
            actions.push(`Помилка створення файлу: ${run.error}`);
            results.push({
              type: "tool_result",
              tool_use_id: tool.id,
              content: run.error,
              is_error: true,
            });
          }
        }
        apiMessages.push({ role: "user", content: results });
        turnLog.push({ role: "user", content: results });
        setStatus(null);
      }

      setStreamText(null);
      setStatus(null);

      if (fillOutcome) setFillResult(fillOutcome);

      // Хід із викликами інструментів зберігаємо повністю, щоб модель пам'ятала, що справді сталося.
      const incomplete =
        finalStop === "tool_use" || finalStop === "pause_turn" || finalContent.some((block) => block.type === "tool_use");
      const storedTurn: ApiMessage[] | null =
        turnLog.length > 0 && !incomplete ? [...turnLog, { role: "assistant", content: finalContent }] : null;

      const replyText =
        fullText.trim() ||
        (produced.length > 0 ? `Створено файл: ${produced.map((f) => f.name).join(", ")}` : "");
      if (replyText) {
        const files: StoredFileMeta[] = [];
        for (const f of produced) files.push(await saveFile(f.name, f.blob));
        const reply = await addMessage(conv.id, "assistant", replyText, usage, files, {
          apiTurn: storedTurn ?? undefined,
          actions: actions.length > 0 ? actions : undefined,
        });
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

      <div className="model-row">
        <label className="muted" htmlFor="model">
          Модель
        </label>
        <select
          id="model"
          className="inset model-select"
          value={currentModel}
          onChange={(e) => void changeModel(e.target.value)}
          disabled={busy}
        >
          {modelOptions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>
      </div>
      {modelsError && <p className="muted">{modelsError}</p>}

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
                <li key={c.id} className="conv-row">
                  <button
                    className="link"
                    type="button"
                    onClick={() => void openConversation(c)}
                    disabled={busy}
                  >
                    {c.title}
                  </button>
                  <button
                    className="link-btn danger"
                    type="button"
                    onClick={() => setConfirmDelete({ kind: "conversation", id: c.id })}
                    disabled={busy}
                  >
                    Видалити
                  </button>
                </li>
              ))}
            </ul>
          )}

          {confirmDelete && (
            <div className="stack-sm confirm-box">
              <p>
                {confirmDelete.kind === "project"
                  ? `Буде видалено проєкт «${selectedProject?.name ?? ""}», його контекст і розмови (${conversations.length}) з повідомленнями та файлами. Це не можна скасувати.`
                  : `Буде видалено розмову «${conversations.find((c) => c.id === confirmDelete.id)?.title ?? ""}» з повідомленнями та файлами. Це не можна скасувати.`}
              </p>
              <div className="file-actions">
                <button
                  className="btn btn-danger"
                  type="button"
                  onClick={() =>
                    void (confirmDelete.kind === "project"
                      ? deleteProjectById(confirmDelete.id)
                      : deleteConversationById(confirmDelete.id))
                  }
                >
                  Так, видалити
                </button>
                <button className="btn" type="button" onClick={() => setConfirmDelete(null)}>
                  Скасувати
                </button>
              </div>
            </div>
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
              <button
                className="btn btn-danger"
                type="button"
                onClick={() => setConfirmDelete({ kind: "project", id: selectedProject.id })}
                disabled={busy}
              >
                Видалити проєкт
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

          <div className="stack-sm">
            <h2 className="section-title">Резервна копія</h2>
            <p className="muted">
              Копія містить проєкти, розмови й повідомлення. Ключ API і файли таблиць до неї не входять.
            </p>
            <button className="btn" type="button" onClick={() => void exportBackup()}>
              Зберегти копію
            </button>
            <label className="btn file-pick">
              Відновити з файлу
              <input
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={(e) => void restoreFromFile(e.target.files?.[0])}
              />
            </label>
            {backupMessage && <p className="muted">{backupMessage}</p>}
          </div>

          <div className="stack-sm">
            <h2 className="section-title">Дозволені сайти</h2>
            <p className="muted">
              Модель відкриватиме посилання тільки з цих доменів. По одному в рядку, наприклад example.com.
              Порожній список вимикає відкриття сайтів.
            </p>
            <textarea
              className="inset"
              rows={3}
              value={domainsDraft}
              onChange={(e) => setDomainsDraft(e.target.value)}
              placeholder="example.com"
            />
            <button className="btn" type="button" onClick={() => void saveDomains()}>
              Зберегти сайти
            </button>
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
              {m.actions && m.actions.length > 0 && (
                <ul className="action-log">
                  {m.actions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              )}
              {m.files && m.files.length > 0 && (
                <div className="file-list">
                  {m.files.map((f) => (
                    <div key={f.id} className="file-card">
                      <span className="file-name">{f.name}</span>
                      <span className="file-meta">Excel · {fmtSize(f.size)}</span>
                      <div className="file-actions">
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => void shareFile(f)}
                        >
                          Поділитися
                        </button>
                        <button type="button" className="btn" onClick={() => void downloadFile(f)}>
                          Зберегти
                        </button>
                      </div>
                    </div>
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

      {notice && <p className="muted">{notice}</p>}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {fillResult && (
        <section className="raised panel stack-sm" aria-label="Зміни до підтвердження">
          <h2 className="section-title">Зміни до підтвердження ({fillResult.diff.length})</h2>
          <ul className="diff-list">
            {fillResult.diff.slice(0, 30).map((d, i) => (
              <li key={i}>
                <span className="muted">
                  {d.sheet} · {d.ref} · {d.header}:
                </span>{" "}
                {d.before || "порожньо"} → <strong>{d.after || "порожньо"}</strong>
              </li>
            ))}
          </ul>
          {fillResult.diff.length > 30 && <p className="muted">Показано перші 30 змін.</p>}
          <div className="file-actions">
            <button className="btn btn-primary" type="button" onClick={() => void confirmFill()}>
              Підтвердити і створити файл
            </button>
            <button className="btn" type="button" onClick={() => setFillResult(null)}>
              Скасувати
            </button>
          </div>
        </section>
      )}

      <div className="attach-row">
        {upload ? (
          <div className="upload-chip">
            <span>Таблиця: {upload.name}</span>
            <button type="button" className="link-btn" onClick={() => setUpload(null)} disabled={busy}>
              Прибрати
            </button>
          </div>
        ) : (
          <label className="btn file-pick">
            Завантажити таблицю
            <input
              type="file"
              accept=".xlsx"
              className="sr-only"
              disabled={busy}
              onChange={(e) => void onUpload(e.target.files?.[0])}
            />
          </label>
        )}
      </div>

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
