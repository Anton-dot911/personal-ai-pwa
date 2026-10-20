// Перевірка розбору стрімінгу з викликом інструмента. Мережі не потрібно: fetch підмінено.
import assert from "node:assert/strict";
import { streamTurn, type TurnEvent } from "../lib/anthropic";

const events = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Готую таблицю."}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"create_xlsx","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"filename\\":\\"t.xlsx\\",\\"sheets\\":"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"[{\\"name\\":\\"A\\",\\"rows\\":[[\\"x\\",1]]}]}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

// Ріжемо потік у довільних місцях, щоб перевірити буферизацію між фрагментами.
const whole = events.join("");
const chunks: string[] = [];
for (let i = 0; i < whole.length; i += 37) chunks.push(whole.slice(i, i + 37));

const enc = new TextEncoder();
globalThis.fetch = (async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}) as typeof fetch;

async function main(): Promise<void> {
  const seen: TurnEvent[] = [];
  for await (const ev of streamTurn({
    apiKey: "test",
    model: "test-model",
    messages: [{ role: "user", content: "Зроби таблицю" }],
    tools: [{ name: "create_xlsx", description: "x", input_schema: { type: "object" } }],
  })) {
    seen.push(ev);
  }

  const texts = seen.filter((e) => e.type === "text");
  assert.equal(texts.map((e) => (e.type === "text" ? e.text : "")).join(""), "Готую таблицю.");

  const done = seen.find((e) => e.type === "done");
  assert.ok(done && done.type === "done", "немає події завершення ходу");
  assert.equal(done.stopReason, "tool_use");
  assert.equal(done.usage.input, 120);
  assert.equal(done.usage.output, 42);
  assert.deepEqual(done.content, [
    { type: "text", text: "Готую таблицю." },
    {
      type: "tool_use",
      id: "toolu_1",
      name: "create_xlsx",
      input: { filename: "t.xlsx", sheets: [{ name: "A", rows: [["x", 1]] }] },
    },
  ]);
  console.log("PASS  розбір стрімінгу з текстом і викликом інструмента");
  console.log("PASS  фрагменти JSON зібрано коректно при розрізаному потоці");
  console.log("PASS  stop_reason і usage з message_delta та message_start");
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
