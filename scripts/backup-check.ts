// Перевірка резервної копії на пам'яті (fake-indexeddb): збереження, відновлення, відхилення.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { addMessage, createConversation, createProject, listConversations } from "../lib/db";
import { buildBackup, parseBackup, restoreBackup } from "../lib/backup";

async function main(): Promise<void> {
  const project = await createProject("Постачання");
  const conv = await createConversation("Тестова розмова", project.id, "claude-test-model");
  await addMessage(conv.id, "user", "Привіт");
  await addMessage(conv.id, "assistant", "Вітаю", { input: 10, cacheWrite: 0, cacheRead: 0, output: 5 });

  const backup = await buildBackup();
  const text = JSON.stringify(backup);
  const parsed = parseBackup(text);
  const mine = parsed.messages.filter((m) => m.conversationId === conv.id);
  assert.equal(mine.length, 2, "копія має містити обидва повідомлення");
  assert.equal(parsed.conversations.find((c) => c.id === conv.id)?.model, "claude-test-model");
  assert.equal(parsed.projects.find((p) => p.id === project.id)?.name, "Постачання");
  console.log("PASS  копія містить проєкт, розмову з моделлю і повідомлення з usage");

  const first = await restoreBackup(text);
  const second = await restoreBackup(text);
  assert.deepEqual(first, second, "повторне відновлення має давати той самий результат");
  const still = (await listConversations()).find((c) => c.id === conv.id);
  assert.ok(still, "розмова має лишитися після відновлення");
  console.log("PASS  відновлення повторюване, дані не дублюються");

  const bad: [string, string, RegExp][] = [
    ["некоректний JSON", "{not json", /некоректний JSON/],
    ["чужий файл", JSON.stringify({ app: "other", version: 1 }), /Це не резервна копія/],
    ["неправильна роль", JSON.stringify({ app: "personal-ai-pwa", version: 1, projects: [], conversations: [], messages: [{ id: "1", conversationId: "c", role: "system", content: "x" }] }), /некоректне повідомлення/],
  ];
  for (const [label, input, pattern] of bad) {
    assert.throws(() => parseBackup(input), pattern);
    console.log(`PASS  відхилено: ${label}`);
  }
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
