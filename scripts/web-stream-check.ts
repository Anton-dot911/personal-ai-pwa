// Перевірка розбору стрімінгу з серверними блоками web_fetch і паузою. Мережі не потрібно.
import assert from "node:assert/strict";
import { streamTurn, type TurnEvent } from "../lib/anthropic";

const events = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":50,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Відкриваю сторінку."}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_fetch","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"url\\":\\"https://example.com/a\\"}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"web_fetch_tool_result","tool_use_id":"srvtoolu_1","content":{"type":"web_fetch_result","url":"https://example.com/a","content":{"type":"document","source":{"type":"text","media_type":"text/plain","data":"Текст"}},"retrieved_at":"2026-10-26T10:00:00Z"}}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":3,"content_block":{"type":"server_tool_use","id":"srvtoolu_2","name":"web_fetch","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"{\\"url\\":\\"https://other.example/b\\"}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":3}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":4,"content_block":{"type":"web_fetch_tool_result","tool_use_id":"srvtoolu_2","content":{"type":"web_fetch_tool_result_error","error_code":"url_not_allowed"}}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":4}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"pause_turn"},"usage":{"output_tokens":30}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

const whole = events.join("");
const chunks: string[] = [];
for (let i = 0; i < whole.length; i += 41) chunks.push(whole.slice(i, i + 41));
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
    messages: [{ role: "user", content: "Відкрий example.com/a" }],
  })) {
    seen.push(ev);
  }
  const done = seen.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.stopReason, "pause_turn", "пауза серверного інструмента має бути збережена");
  assert.deepEqual(
    done.content.map((b) => b.type),
    ["text", "server_tool_use", "web_fetch_tool_result", "server_tool_use", "web_fetch_tool_result"]
  );
  assert.deepEqual(done.content[1], {
    type: "server_tool_use",
    id: "srvtoolu_1",
    name: "web_fetch",
    input: { url: "https://example.com/a" },
  });
  console.log("PASS  серверні блоки web_fetch збережено в порядку, пауза розпізнана");
  console.log("PASS  помилка відкриття сторінки збережена як результат");
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
