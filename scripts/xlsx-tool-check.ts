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
  // Суми і дати, передані текстом, мають стати числами і датами у файлі.
  const journal = {
    filename: "journal.xlsx",
    sheets: [
      {
        name: "Журнал",
        columns: [{ cellStyle: { numFmt: "dd.mm.yyyy" } }, { cellStyle: { numFmt: "#,##0.00" } }],
        rows: [["Дата", "Сума, грн"], ["01.03.2025", "1200"], ["2025-03-05", "350,5"]],
        validations: [{ ref: "B2:B11", type: "decimal", operator: "greaterThan", formulae: [0] }],
      },
    ],
  };
  const jr = await runCreateXlsx(journal);
  assert.ok(jr.ok, !jr.ok ? jr.error : "");
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const bytes = Buffer.from(await jr.blob.arrayBuffer()) as unknown as Parameters<typeof wb.xlsx.load>[0];
  await wb.xlsx.load(bytes);
  const ws = wb.getWorksheet("Журнал");
  assert.ok(ws, "аркуш не знайдено");
  assert.equal(ws.getCell("B2").value, 1200);
  assert.equal(ws.getCell("B3").value, 350.5);
  const d1 = ws.getCell("A2").value;
  assert.ok(d1 instanceof Date, "дата має бути Date, а не текст");
  assert.equal(d1.toISOString().slice(0, 10), "2025-03-01");
  const d2 = ws.getCell("A3").value;
  assert.ok(d2 instanceof Date, "дата у форматі ISO має бути Date");
  assert.equal(d2.toISOString().slice(0, 10), "2025-03-05");
  console.log("PASS  суми з тексту стали числами, дати стали датами у файлі");

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
