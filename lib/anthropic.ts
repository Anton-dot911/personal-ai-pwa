// Прямі запити з браузера до API Anthropic. Ключ іде лише в заголовку x-api-key.
export const API_URL = "https://api.anthropic.com/v1";
const API_VERSION = "2023-06-01";
const NETWORK_ERROR =
  "Немає зв'язку з api.anthropic.com. Перевірте інтернет і спробуйте знову.";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
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
  error?: { message?: string };
}

function parseEvent(raw: string): string | null {
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) return null;
  const payload = dataLine.slice(5).trim();
  if (!payload) return null;

  const event = JSON.parse(payload) as StreamEvent;
  if (event.type === "error") {
    throw new ApiError(event.error?.message ?? "Під час відповіді сталася помилка.");
  }
  if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
    return event.delta.text ?? null;
  }
  return null;
}

// Стрімінг відповіді: віддає фрагменти тексту по мірі надходження.
export async function* streamMessage(params: {
  apiKey: string;
  model: string;
  messages: ChatTurn[];
  signal?: AbortSignal;
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
        const text = parseEvent(raw);
        if (text) yield text;
        end = buffer.indexOf("\n\n");
      }
    }
  } catch (err) {
    if (isAbort(err)) return;
    throw err instanceof ApiError ? err : new ApiError(NETWORK_ERROR);
  }
}

// API вимагає чергування ролей. Сусідні повідомлення однієї ролі (наприклад,
// після невдалої відповіді) об'єднуються в один хід.
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
