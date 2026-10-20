// Перевірка списку моделей: пагінація по after_id і зрозуміла помилка для неправильного ключа.
import assert from "node:assert/strict";
import { ApiError, listModels } from "../lib/anthropic";

const calls: string[] = [];
const firstPage = {
  data: [
    { id: "claude-a", display_name: "Claude A" },
    { id: "claude-b", display_name: "Claude B" },
  ],
  has_more: true,
  last_id: "claude-b",
};
const secondPage = { data: [{ id: "claude-c", display_name: "Claude C" }], has_more: false, last_id: "claude-c" };

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  calls.push(url);
  const body = url.includes("after_id=claude-b") ? secondPage : firstPage;
  return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;

async function main(): Promise<void> {
  const list = await listModels("test-key");
  assert.deepEqual(list.map((m) => m.id), ["claude-a", "claude-b", "claude-c"]);
  assert.equal(list[2].displayName, "Claude C");
  assert.equal(calls.length, 2, "мало бути два запити, другий з after_id");
  assert.ok(calls[1].includes("after_id=claude-b"));
  console.log("PASS  список моделей з двох сторінок зібрано в правильному порядку");

  globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
  await assert.rejects(
    () => listModels("bad-key"),
    (err: unknown) => err instanceof ApiError && /Ключ не пройшов перевірку/.test(err.message)
  );
  console.log("PASS  неправильний ключ дає зрозуміле повідомлення");
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
