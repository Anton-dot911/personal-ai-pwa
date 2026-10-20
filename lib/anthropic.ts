// Прямі запити з браузера до API Anthropic. Ключ іде лише в заголовку x-api-key.
export const API_URL = "https://api.anthropic.com/v1";
const API_VERSION = "2023-06-01";
const NETWORK_ERROR =
  "Немає зв'язку з api.anthropic.com. Перевірте інтернет і спробуйте знову.";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

// Лічильник токенів із поля usage відповіді API.
export interface Usage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface ApiMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type TurnEvent =
  | { type: "text"; text: string }
  | { type: "done"; content: ContentBlock[]; stopReason: string | null; usage: Usage };

interface RawUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiError";
  }
}

function headers(apiKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": API_VERSION,
    // Обов'язковий заголовок для запитів, які роблять прямо з браузера.
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

function explainStatus(status: number): string {
  if (status === 401 || status === 403) {
    return "Ключ не пройшов перевірку. Скопіюйте його повністю з кабінету Anthropic і спробуйте знову.";
  }
  if (status === 429) return "Забагато запитів. Зачекайте хвилину і спробуйте знову.";
  if (status >= 500) return "Сервіс Anthropic тимчасово недоступний. Спробуйте пізніше.";
  return `Запит відхилено (код ${status}). Перевірте, чи модель доступна для вашого ключа.`;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function emptyUsage(): Usage {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
}

function applyRawUsage(target: Usage, raw?: RawUsage): void {
  if (!raw) return;
  if (raw.input_tokens !== undefined) target.input = raw.input_tokens;
  if (raw.cache_creation_input_tokens !== undefined) target.cacheWrite = raw.cache_creation_input_tokens;
  if (raw.cache_read_input_tokens !== undefined) target.cacheRead = raw.cache_read_input_tokens;
  if (raw.output_tokens !== undefined) target.output = raw.output_tokens;
}

// Перевірка ключа без витрат токенів: список моделей.
export async function validateApiKey(apiKey: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/models?limit=1`, { headers: headers(apiKey) });
  } catch {
    throw new ApiError(NETWORK_ERROR);
  }
  if (!res.ok) throw new ApiError(explainStatus(res.status));
}

interface StreamEvent {
  type: string;
  index?: number;
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null };
  content_block?: { type?: string; id?: string; name?: string };
  message?: { usage?: RawUsage };
  usage?: RawUsage;
  error?: { message?: string };
}

interface BlockAcc {
  kind: "text" | "tool_use";
  text: string;
  id?: string;
  name?: string;
  json: string;
}

function parseSse(raw: string): StreamEvent | null {
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) return null;
  const payload = dataLine.slice(5).trim();
  if (!payload) return null;
  return JSON.parse(payload) as StreamEvent;
}

function parseToolInput(json: string): unknown {
  if (!json) return {};
  try {
    return JSON.parse(json);
  } catch {
    // Некоректний JSON від моделі перетворюємо на порожній ввід: інструмент повідомить про помилку.
    return {};
  }
}

// Один хід моделі зі стрімінгом. Текст віддається по мірі надходження, а наприкінці
// приходить повний список блоків, включно з викликами інструментів.
export async function* streamTurn(params: {
  apiKey: string;
  model: string;
  system?: SystemBlock[];
  messages: ApiMessage[];
  tools?: ToolDef[];
  signal?: AbortSignal;
  maxTokens?: number;
}): AsyncGenerator<TurnEvent> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/messages`, {
      method: "POST",
      headers: headers(params.apiKey),
      body: JSON.stringify({
        model: params.model,
        max_tokens: params.maxTokens ?? 2048,
        stream: true,
        system: params.system && params.system.length > 0 ? params.system : undefined,
        tools: params.tools && params.tools.length > 0 ? params.tools : undefined,
        messages: params.messages,
      }),
      signal: params.signal,
    });
  } catch (err) {
    if (isAbort(err)) return;
    throw new ApiError(NETWORK_ERROR);
  }
  if (!res.ok || !res.body) throw new ApiError(explainStatus(res.status));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const usage = emptyUsage();
  const blocks = new Map<number, BlockAcc>();
  let stopReason: string | null = null;
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\n\n");

        const event = parseSse(raw);
        if (!event) continue;

        if (event.type === "error") {
          throw new ApiError(event.error?.message ?? "Під час відповіді сталася помилка.");
        }
        if (event.type === "message_start") applyRawUsage(usage, event.message?.usage);
        if (event.type === "message_delta") {
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          applyRawUsage(usage, event.usage);
        }
        if (event.type === "content_block_start" && event.index !== undefined) {
          const cb = event.content_block;
          blocks.set(
            event.index,
            cb?.type === "tool_use"
              ? { kind: "tool_use", text: "", id: cb.id, name: cb.name, json: "" }
              : { kind: "text", text: "", json: "" }
          );
        }
        if (event.type === "content_block_delta" && event.index !== undefined && event.delta) {
          const block = blocks.get(event.index);
          if (!block) continue;
          if (event.delta.type === "text_delta") {
            const piece = event.delta.text ?? "";
            block.text += piece;
            if (piece) yield { type: "text", text: piece };
          } else if (event.delta.type === "input_json_delta") {
            block.json += event.delta.partial_json ?? "";
          }
        }
      }
    }
  } catch (err) {
    if (isAbort(err)) return;
    throw err instanceof ApiError ? err : new ApiError(NETWORK_ERROR);
  }

  const content: ContentBlock[] = [];
  for (const index of [...blocks.keys()].sort((a, b) => a - b)) {
    const block = blocks.get(index);
    if (!block) continue;
    if (block.kind === "text" && block.text) {
      content.push({ type: "text", text: block.text });
    }
    if (block.kind === "tool_use") {
      content.push({
        type: "tool_use",
        id: block.id ?? "",
        name: block.name ?? "",
        input: parseToolInput(block.json),
      });
    }
  }
  yield { type: "done", content, stopReason, usage };
}

// Запит без стрімінгу, наприклад для підсумку розмови.
export async function completeText(params: {
  apiKey: string;
  model: string;
  system?: SystemBlock[];
  messages: ChatTurn[];
  maxTokens?: number;
}): Promise<{ text: string; usage: Usage }> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/messages`, {
      method: "POST",
      headers: headers(params.apiKey),
      body: JSON.stringify({
        model: params.model,
        max_tokens: params.maxTokens ?? 1024,
        system: params.system && params.system.length > 0 ? params.system : undefined,
        messages: params.messages,
      }),
    });
  } catch {
    throw new ApiError(NETWORK_ERROR);
  }
  if (!res.ok) throw new ApiError(explainStatus(res.status));

  const data = (await res.json()) as {
    content: { type: string; text?: string }[];
    usage?: RawUsage;
  };
  const text = data.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  const usage = emptyUsage();
  applyRawUsage(usage, data.usage);
  return { text, usage };
}

// API вимагає чергування ролей. Сусідні повідомлення однієї ролі об'єднуються.
export function toTurns(messages: ChatTurn[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const m of messages) {
    const last = turns[turns.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      turns.push({ role: m.role, content: m.content });
    }
  }
  return turns;
}
