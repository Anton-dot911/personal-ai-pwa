import { completeText, type SystemBlock, type Usage } from "@/lib/anthropic";
import { KEEP_RECENT_MESSAGES } from "@/lib/config";
import type { Message, Project } from "@/lib/db";

const SUMMARY_INSTRUCTIONS =
  "Ти стискаєш розмову для подальшої роботи. Збережи цілі користувача, прийняті рішення, імена, числа, назви файлів, відкриті питання і вимоги до відповідей. Пиши стисло, мовою розмови, без вступу. Не додавай нічого, чого не було в тексті.";

// Розмір контексту за даними останньої відповіді API.
export function contextSize(usage?: Usage): number {
  if (!usage) return 0;
  return usage.input + usage.cacheWrite + usage.cacheRead + usage.output;
}

// Системні блоки: закріплений контекст проєкту і підсумок. Кеш ставиться на останній блок,
// тож уся стабільна частина префікса кешується разом.
export function buildSystem(project: Project | null, summary: string | null): SystemBlock[] {
  const blocks: SystemBlock[] = [];
  if (project && project.pinnedContext.trim()) {
    blocks.push({
      type: "text",
      text: `Контекст проєкту "${project.name}":\n${project.pinnedContext.trim()}`,
    });
  }
  if (summary) {
    blocks.push({
      type: "text",
      text: `Підсумок попередньої частини розмови:\n${summary}`,
    });
  }
  if (blocks.length > 0) {
    blocks[blocks.length - 1].cache_control = { type: "ephemeral" };
  }
  return blocks;
}

// Визначає, які повідомлення варто стиснути. Лишає останні KEEP_RECENT_MESSAGES дослівно.
// Межа завжди падає перед повідомленням користувача, щоб історія починалась з user.
export function splitForCompaction(
  messages: Message[],
  cutoff: number | undefined
): { toSummarize: Message[]; cutoffAt: number } | null {
  const candidates = messages.filter((m) => m.createdAt > (cutoff ?? 0));
  if (candidates.length <= KEEP_RECENT_MESSAGES) return null;

  let boundary = candidates.length - KEEP_RECENT_MESSAGES;
  if (candidates[boundary].role === "assistant") boundary += 1;
  if (boundary >= candidates.length) return null;

  const toSummarize = candidates.slice(0, boundary);
  return { toSummarize, cutoffAt: toSummarize[toSummarize.length - 1].createdAt };
}

export async function compactConversation(params: {
  apiKey: string;
  model: string;
  summary: string | null;
  toSummarize: Message[];
}): Promise<string> {
  const transcript = params.toSummarize
    .map((m) => `${m.role === "user" ? "Користувач" : "Асистент"}: ${m.content}`)
    .join("\n\n");
  const prior = params.summary ? `Попередній підсумок:\n${params.summary}\n\n` : "";

  const { text } = await completeText({
    apiKey: params.apiKey,
    model: params.model,
    system: [{ type: "text", text: SUMMARY_INSTRUCTIONS }],
    messages: [{ role: "user", content: `${prior}Нові повідомлення:\n\n${transcript}` }],
    maxTokens: 1500,
  });

  const summary = text.trim();
  if (!summary) throw new Error("Не вдалося стиснути розмову. Спробуйте ще раз.");
  return summary;
}
