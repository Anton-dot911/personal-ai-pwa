import {
  importRecords,
  listAllMessages,
  listConversations,
  listProjects,
  type Conversation,
  type Message,
  type Project,
} from "@/lib/db";

// Резервна копія: проєкти, розмови і повідомлення. Ключ API і файли таблиць не входять.
export interface BackupFile {
  app: "personal-ai-pwa";
  version: 1;
  exportedAt: string;
  projects: Project[];
  conversations: Conversation[];
  messages: Message[];
}

function fail(message: string): never {
  throw new Error(message);
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkList(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) fail(`У копії немає списку «${name}».`);
  return value as unknown[];
}

function checkProject(raw: unknown): Project {
  if (!isObj(raw) || typeof raw.id !== "string" || typeof raw.name !== "string") {
    fail("У копії некоректний проєкт.");
  }
  return {
    id: raw.id,
    name: raw.name,
    pinnedContext: typeof raw.pinnedContext === "string" ? raw.pinnedContext : "",
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

function checkConversation(raw: unknown): Conversation {
  if (!isObj(raw) || typeof raw.id !== "string" || typeof raw.title !== "string") {
    fail("У копії некоректна розмова.");
  }
  return {
    id: raw.id,
    projectId: typeof raw.projectId === "string" ? raw.projectId : null,
    title: raw.title,
    summary: typeof raw.summary === "string" ? raw.summary : undefined,
    summaryCutoff: typeof raw.summaryCutoff === "number" ? raw.summaryCutoff : undefined,
    model: typeof raw.model === "string" ? raw.model : undefined,
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

function checkMessage(raw: unknown): Message {
  if (
    !isObj(raw) ||
    typeof raw.id !== "string" ||
    typeof raw.conversationId !== "string" ||
    (raw.role !== "user" && raw.role !== "assistant") ||
    typeof raw.content !== "string"
  ) {
    fail("У копії некоректне повідомлення.");
  }
  return {
    id: raw.id,
    conversationId: raw.conversationId,
    role: raw.role,
    content: raw.content,
    usage: isObj(raw.usage) ? (raw.usage as unknown as Message["usage"]) : undefined,
    files: Array.isArray(raw.files) ? (raw.files as Message["files"]) : undefined,
    createdAt: Number(raw.createdAt) || 0,
  };
}

export async function buildBackup(): Promise<BackupFile> {
  const [projects, conversations, messages] = await Promise.all([
    listProjects(),
    listConversations(),
    listAllMessages(),
  ]);
  return {
    app: "personal-ai-pwa",
    version: 1,
    exportedAt: new Date().toISOString(),
    projects,
    conversations,
    messages,
  };
}

export function backupFilename(date: Date = new Date()): string {
  return `personal-ai-backup-${date.toISOString().slice(0, 10)}.json`;
}

export function parseBackup(text: string): BackupFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    fail("Файл не є резервною копією застосунку: некоректний JSON.");
  }
  if (!isObj(data) || data.app !== "personal-ai-pwa" || data.version !== 1) {
    fail("Це не резервна копія цього застосунку.");
  }
  return {
    app: "personal-ai-pwa",
    version: 1,
    exportedAt: typeof data.exportedAt === "string" ? data.exportedAt : "",
    projects: checkList(data.projects, "projects").map(checkProject),
    conversations: checkList(data.conversations, "conversations").map(checkConversation),
    messages: checkList(data.messages, "messages").map(checkMessage),
  };
}

export async function restoreBackup(text: string): Promise<{
  projects: number;
  conversations: number;
  messages: number;
}> {
  const backup = parseBackup(text);
  await importRecords(backup);
  return {
    projects: backup.projects.length,
    conversations: backup.conversations.length,
    messages: backup.messages.length,
  };
}
