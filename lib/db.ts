import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from "idb";
import type { Usage } from "@/lib/anthropic";
import { DEFAULT_MODEL } from "@/lib/config";

export type Role = "user" | "assistant";

export interface Project {
  id: string;
  name: string;
  pinnedContext: string;
  createdAt: number;
  updatedAt: number;
}

export interface Conversation {
  id: string;
  projectId: string | null;
  title: string;
  summary?: string;
  summaryCutoff?: number;
  model?: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoredFileMeta {
  id: string;
  name: string;
  size: number;
}

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  usage?: Usage;
  files?: StoredFileMeta[];
  createdAt: number;
}

interface FileRecord extends StoredFileMeta {
  blob: Blob;
  createdAt: number;
}

interface Secret {
  id: "anthropic";
  apiKey: string;
}

interface Setting {
  key: string;
  value: unknown;
}

interface AppDB extends DBSchema {
  projects: { key: string; value: Project };
  conversations: { key: string; value: Conversation; indexes: { "by-updated": number } };
  messages: { key: string; value: Message; indexes: { "by-conversation": string } };
  secrets: { key: string; value: Secret };
  settings: { key: string; value: Setting };
  files: { key: string; value: FileRecord };
}

const DB_NAME = "personal-ai";
const DB_VERSION = 3;

let dbPromise: Promise<IDBPDatabase<AppDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<AppDB>> {
  if (!dbPromise) {
    dbPromise = openDB<AppDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const conversations = db.createObjectStore("conversations", { keyPath: "id" });
          conversations.createIndex("by-updated", "updatedAt");
          const messages = db.createObjectStore("messages", { keyPath: "id" });
          messages.createIndex("by-conversation", "conversationId");
          db.createObjectStore("secrets", { keyPath: "id" });
          db.createObjectStore("settings", { keyPath: "key" });
        }
        if (oldVersion < 2) {
          db.createObjectStore("projects", { keyPath: "id" });
        }
        if (oldVersion < 3) {
          db.createObjectStore("files", { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

export const newId = (): string => crypto.randomUUID();

// Ключ зберігається без шифрування на цьому пристрої. Шифрування паролем додамо пізніше.
export async function getApiKey(): Promise<string | null> {
  const row = await (await getDB()).get("secrets", "anthropic");
  return row?.apiKey ?? null;
}

export async function saveApiKey(apiKey: string): Promise<void> {
  await (await getDB()).put("secrets", { id: "anthropic", apiKey });
}

export async function getModel(): Promise<string> {
  const row = await (await getDB()).get("settings", "model");
  return typeof row?.value === "string" ? row.value : DEFAULT_MODEL;
}

export async function listProjects(): Promise<Project[]> {
  const all = await (await getDB()).getAll("projects");
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function createProject(name: string): Promise<Project> {
  const now = Date.now();
  const project: Project = { id: newId(), name, pinnedContext: "", createdAt: now, updatedAt: now };
  await (await getDB()).put("projects", project);
  return project;
}

export async function updateProjectContext(id: string, pinnedContext: string): Promise<void> {
  const db = await getDB();
  const project = await db.get("projects", id);
  if (project) {
    await db.put("projects", { ...project, pinnedContext, updatedAt: Date.now() });
  }
}

// Без аргумента повертає всі розмови. projectId: null означає розмови без проєкту.
export async function listConversations(projectId?: string | null): Promise<Conversation[]> {
  const all = await (await getDB()).getAllFromIndex("conversations", "by-updated");
  const filtered = projectId === undefined ? all : all.filter((c) => c.projectId === projectId);
  return filtered.reverse();
}

export async function createConversation(
  title: string,
  projectId: string | null = null,
  model?: string
): Promise<Conversation> {
  const now = Date.now();
  const conversation: Conversation = {
    id: newId(),
    projectId,
    title,
    model,
    createdAt: now,
    updatedAt: now,
  };
  await (await getDB()).put("conversations", conversation);
  return conversation;
}

export async function touchConversation(id: string): Promise<void> {
  const db = await getDB();
  const conversation = await db.get("conversations", id);
  if (conversation) {
    await db.put("conversations", { ...conversation, updatedAt: Date.now() });
  }
}

export async function updateConversationSummary(
  id: string,
  summary: string,
  summaryCutoff: number
): Promise<void> {
  const db = await getDB();
  const conversation = await db.get("conversations", id);
  if (conversation) {
    await db.put("conversations", { ...conversation, summary, summaryCutoff });
  }
}

export async function addMessage(
  conversationId: string,
  role: Role,
  content: string,
  usage?: Usage,
  files?: StoredFileMeta[]
): Promise<Message> {
  const message: Message = {
    id: newId(),
    conversationId,
    role,
    content,
    usage,
    files,
    createdAt: Date.now(),
  };
  await (await getDB()).put("messages", message);
  return message;
}

// Файли зберігаються в IndexedDB, щоб залишатися доступними після перезавантаження.
export async function saveFile(name: string, blob: Blob): Promise<StoredFileMeta> {
  const record: FileRecord = { id: newId(), name, size: blob.size, blob, createdAt: Date.now() };
  await (await getDB()).put("files", record);
  return { id: record.id, name, size: record.size };
}

export async function getFileBlob(id: string): Promise<Blob | null> {
  const record = await (await getDB()).get("files", id);
  return record?.blob ?? null;
}

export async function getMessages(conversationId: string): Promise<Message[]> {
  const all = await (await getDB()).getAllFromIndex("messages", "by-conversation", conversationId);
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

// Модель зберігається окремо для кожної розмови.
export async function setConversationModel(id: string, model: string): Promise<void> {
  const db = await getDB();
  const conversation = await db.get("conversations", id);
  if (conversation) {
    await db.put("conversations", { ...conversation, model });
  }
}

export async function listAllMessages(): Promise<Message[]> {
  return (await getDB()).getAll("messages");
}

// Записує дані з резервної копії. Однакові id оновлюються, тож повторне відновлення безпечне.
export async function importRecords(data: {
  projects: Project[];
  conversations: Conversation[];
  messages: Message[];
}): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["projects", "conversations", "messages"], "readwrite");
  for (const p of data.projects) void tx.objectStore("projects").put(p);
  for (const c of data.conversations) void tx.objectStore("conversations").put(c);
  for (const m of data.messages) void tx.objectStore("messages").put(m);
  await tx.done;
}

type WriteTx = IDBPTransaction<AppDB, ("projects" | "conversations" | "messages" | "files")[], "readwrite">;

// Видаляє розмову, її повідомлення і файли, створені в ній.
async function removeConversationData(tx: WriteTx, conversationId: string): Promise<void> {
  const messages = await tx.objectStore("messages").index("by-conversation").getAll(conversationId);
  for (const message of messages) {
    for (const file of message.files ?? []) {
      await tx.objectStore("files").delete(file.id);
    }
    await tx.objectStore("messages").delete(message.id);
  }
  await tx.objectStore("conversations").delete(conversationId);
}

export async function deleteConversation(id: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["projects", "conversations", "messages", "files"], "readwrite");
  await removeConversationData(tx, id);
  await tx.done;
}

// Видаляє проєкт разом з його контекстом, розмовами, повідомленнями і файлами.
export async function deleteProject(id: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["projects", "conversations", "messages", "files"], "readwrite");
  const conversations = await tx.objectStore("conversations").getAll();
  for (const conversation of conversations) {
    if (conversation.projectId === id) await removeConversationData(tx, conversation.id);
  }
  await tx.objectStore("projects").delete(id);
  await tx.done;
}
