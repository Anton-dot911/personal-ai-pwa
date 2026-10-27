// Перевірка історії для API: хід з інструментом відтворюється повністю.
import assert from "node:assert/strict";
import type { ApiMessage } from "../lib/anthropic";
import { toApiHistory } from "../lib/context";
import type { Message } from "../lib/db";

const turn: ApiMessage[] = [
  { role: "assistant", content: [
    { type: "text", text: "Підготую зміну." },
    { type: "tool_use", id: "t1", name: "fill_xlsx", input: { changes: [] } },
  ] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Підготовлено змін: 1" }] },
  { role: "assistant", content: "Зміну підготовано." },
];

const history: Message[] = [
  { id: "1", conversationId: "c", role: "user", content: "Зміни B3", createdAt: 1 },
  { id: "2", conversationId: "c", role: "assistant", content: "Зміну підготовано.", createdAt: 2, apiTurn: turn, actions: ["Підготовлено змін: 1"] },
  { id: "3", conversationId: "c", role: "user", content: "Дякую", createdAt: 3 },
  { id: "4", conversationId: "c", role: "user", content: "Ще питання", createdAt: 4 },
];

const api = toApiHistory(history);
assert.deepEqual(api.map((m) => m.role), ["user", "assistant", "user", "assistant", "user"]);
assert.ok(Array.isArray(api[1].content) && api[1].content[1].type === "tool_use", "виклик інструмента має бути відтворений");
assert.ok(Array.isArray(api[2].content) && api[2].content[0].type === "tool_result", "результат інструмента має бути відтворений");
assert.equal(api[3].content, "Зміну підготовано.");
assert.equal(api[4].content, "Дякую\n\nЩе питання", "звичайні повідомлення з однієї ролі об'єднуються");
console.log("PASS  хід з викликом інструмента відтворюється в історії повністю");

const plain = toApiHistory([{ id: "9", conversationId: "c", role: "assistant", content: "Просто текст", createdAt: 1 }]);
assert.deepEqual(plain, [{ role: "assistant", content: "Просто текст" }]);
console.log("PASS  звичайна відповідь без інструментів лишається текстом");

// Повідомлення застосунку про створений файл подається моделі як факт від застосунку.
const appHist: Message[] = [
  { id: "a", conversationId: "c", role: "user", content: "Зміни клітинку", createdAt: 1 },
  { id: "b", conversationId: "c", role: "assistant", content: "Файл з підтвердженими змінами: x.xlsx", createdAt: 2, source: "app" },
  { id: "d", conversationId: "c", role: "user", content: "Що далі?", createdAt: 3 },
];
const appApi = toApiHistory(appHist);
assert.equal(appApi.length, 1, "сусідні повідомлення користувача об'єднуються");
assert.ok(
  typeof appApi[0].content === "string" && appApi[0].content.includes("[Повідомлення застосунку] Файл з підтвердженими змінами: x.xlsx"),
  "повідомлення застосунку має бути в історії як факт від застосунку"
);
console.log("PASS  повідомлення застосунку про файл подається моделі як факт від застосунку");
