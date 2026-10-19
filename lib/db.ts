import { openDB, type DBSchema, type IDBPDatabase } from "idb";
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
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  usage?: Usage;
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
}

const DB_NAME = "personal-ai";
const DB_VERSION = 2;

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
  projectId: string | null = null
): Promise<Conversation> {
  const now = Date.now();
  const conversation: Conversation = { id: newId(), projectId, title, createdAt: now, updatedAt: now };
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
  usage?: Usage
): Promise<Message> {
  const message: Message = { id: newId(), conversationId, role, content, usage, createdAt: Date.now() };
  await (await getDB()).put("messages", message);
  return message;
}

export async function getMessages(conversationId: string): Promise<Message[]> {
  const all = await (await getDB()).getAllFromIndex("messages", "by-conversation", conversationId);
  return all.sort((a, b) => a.createdAt - b.createdAt);
}
