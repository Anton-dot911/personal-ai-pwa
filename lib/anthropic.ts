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
  delta?: { type?: string; text?: string };
  message?: { usage?: RawUsage };
  usage?: RawUsage;
  error?: { message?: string };
}

function handleEvent(raw: string, usage: Usage): string | null {
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) return null;
  const payload = dataLine.slice(5).trim();
  if (!payload) return null;

  const event = JSON.parse(payload) as StreamEvent;
  if (event.type === "error") {
    throw new ApiError(event.error?.message ?? "Під час відповіді сталася помилка.");
  }
  if (event.type === "message_start") applyRawUsage(usage, event.message?.usage);
  if (event.type === "message_delta") applyRawUsage(usage, event.usage);
  if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
    return event.delta.text ?? null;
  }
  return null;
}

// Стрімінг: віддає фрагменти тексту, а наприкінці передає usage через onUsage.
export async function* streamMessage(params: {
  apiKey: string;
  model: string;
  system?: SystemBlock[];
  messages: ChatTurn[];
  signal?: AbortSignal;
  onUsage?: (usage: Usage) => void;
}): AsyncGenerator<string> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/messages`, {
      method: "POST",
      headers: headers(params.apiKey),
      body: JSON.stringify({
        model: params.model,
        max_tokens: 2048,
        stream: true,
        system: params.system && params.system.length > 0 ? params.system : undefined,
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
        const text = handleEvent(raw, usage);
        if (text) yield text;
        end = buffer.indexOf("\n\n");
      }
    }
  } catch (err) {
    if (isAbort(err)) return;
    throw err instanceof ApiError ? err : new ApiError(NETWORK_ERROR);
  }

  params.onUsage?.(usage);
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

