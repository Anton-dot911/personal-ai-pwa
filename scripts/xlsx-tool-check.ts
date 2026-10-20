// Перевірка інструмента create_xlsx: коректний опис створює файл, некоректний дає зрозумілу помилку.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { runCreateXlsx } from "../lib/xlsx/tool";

async function main(): Promise<void> {
  const good = JSON.parse(readFileSync("lib/xlsx/examples/suppliers.spec.json", "utf8"));
  const ok = await runCreateXlsx(good);
  assert.ok(ok.ok, !ok.ok ? ok.error : "");
  assert.equal(ok.name, "suppliers_template.xlsx");
  assert.ok(ok.blob.size > 1000, "файл занадто малий");
  console.log(`PASS  коректний опис створює файл (${ok.blob.size} байт)`);

  const cases: [string, unknown, RegExp][] = [
    ["назва з забороненим символом", { sheets: [{ name: "A/B", rows: [] }] }, /символи/],
    ["формула з дужкою =", { sheets: [{ name: "A", rows: [[{ formula: "=SUM(A1)" }]] }] }, /без знака/],
    ["некоректний колір", { sheets: [{ name: "A", rows: [], columns: [{ headerStyle: { fill: "red" } }] }] }, /ARGB/],
    ["повторна назва аркуша", { sheets: [{ name: "A", rows: [] }, { name: "a", rows: [] }] }, /повторюється/],
    ["відсутні аркуші", {}, /sheets/],
    ["адреса закріплення", { sheets: [{ name: "A", rows: [], freeze: "2A" }] }, /некоректна адреса/],
  ];
  for (const [label, input, pattern] of cases) {
    const res = await runCreateXlsx(input);
    assert.ok(!res.ok, `має бути помилка: ${label}`);
    assert.match(res.error, pattern);
    console.log(`PASS  помилка: ${label} → «${res.error}»`);
  }
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
