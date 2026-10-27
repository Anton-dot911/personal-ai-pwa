// Перевірка доменів і інструмента web_fetch.
import assert from "node:assert/strict";
import { buildWebFetchTool, parseDomains } from "../lib/web";

const parsed = parseDomains("https://Example.com/path\n docs.example.com, bad_domain");
assert.deepEqual(parsed.domains, ["example.com", "docs.example.com"]);
assert.deepEqual(parsed.invalid, ["bad_domain"]);
console.log("PASS  домени: повні адреси скорочуються, некоректні відхиляються");

assert.equal(buildWebFetchTool([]), null, "без доменів інструмент не додається");
const tool = buildWebFetchTool(["example.com"]) as Record<string, unknown>;
assert.equal(tool.type, "web_fetch_20250910");
assert.deepEqual(tool.allowed_domains, ["example.com"]);
assert.deepEqual(tool.url_sources, { client_tool_results: { type: "none" } });
console.log("PASS  інструмент обмежений дозволеними доменами, джерела з результатів інструментів вимкнено");
