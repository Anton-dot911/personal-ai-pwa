import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { DEFAULT_MODEL } from "@/lib/config";

export type Role = "user" | "assistant";

export interface Conversation {
  id: string;
  projectId: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  tokenCount?: number;
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
  conversations: {
    key: string;
    value: Conversation;
    indexes: { "by-updated": number };
  };
  messages: {
    key: string;
    value: Message;
    indexes: { "by-conversation": string };
  };
  secrets: { key: string; value: Secret };
  settings: { key: string; value: Setting };
}

const DB_NAME = "personal-ai";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<AppDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<AppDB>> {
  if (!dbPromise) {
    dbPromise = openDB<AppDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const conversations = db.createObjectStore("conversations", { keyPath: "id" });
        conversations.createIndex("by-updated", "updatedAt");
        const messages = db.createObjectStore("messages", { keyPath: "id" });
        messages.createIndex("by-conversation", "conversationId");
        db.createObjectStore("secrets", { keyPath: "id" });
        db.createObjectStore("settings", { keyPath: "key" });
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

export async function listConversations(): Promise<Conversation[]> {
  const all = await (await getDB()).getAllFromIndex("conversations", "by-updated");
  return all.reverse();
}

export async function createConversation(title: string): Promise<Conversation> {
  const now = Date.now();
  const conversation: Conversation = {
    id: newId(),
    projectId: null,
    title,
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

export async function addMessage(
  conversationId: string,
  role: Role,
  content: string
): Promise<Message> {
  const message: Message = {
    id: newId(),
    conversationId,
    role,
    content,
    createdAt: Date.now(),
  };
  await (await getDB()).put("messages", message);
  return message;
}

export async function getMessages(conversationId: string): Promise<Message[]> {
  const all = await (await getDB()).getAllFromIndex(
    "messages",
    "by-conversation",
    conversationId
  );
  return all.sort((a, b) => a.createdAt - b.createdAt);
}
