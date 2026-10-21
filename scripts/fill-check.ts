// Перевірка заповнення шаблону: змінюються лише поля вводу, формули і правила лишаються.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runCreateXlsx } from "../lib/xlsx/tool";
import { applyChanges, inspectXlsx, loadWorkbook, textOf, type CellChange } from "../lib/xlsx/fill";

async function main(): Promise<void> {
  const spec = JSON.parse(readFileSync("lib/xlsx/examples/suppliers.spec.json", "utf8"));
  const made = await runCreateXlsx(spec);
  assert.ok(made.ok, !made.ok ? made.error : "");
  const original = await made.blob.arrayBuffer();

  const info = await inspectXlsx(original);
  const sheet = info.find((s) => s.name === "Постачальники");
  assert.ok(sheet, "аркуш Постачальники не знайдено");
  assert.equal(sheet.formulas, 240);
  assert.equal(sheet.validations, 6);
  assert.equal(sheet.conditionals, 1);
  console.log("PASS  огляд файлу: аркуші, формули, валідація і умовне форматування видно");

  const inputs = { "Постачальники": ["B", "H", "I", "K", "L", "M", "N", "O"] };
  const changes: CellChange[] = [
    { sheet: "Постачальники", ref: "B2", value: "Агроль" },
    { sheet: "Постачальники", ref: "H2", value: "49.96" },
    { sheet: "Постачальники", ref: "I2", value: "24.61" },
    { sheet: "Постачальники", ref: "N3", value: "120" },
  ];
  const { blob, diff } = await applyChanges(original, changes, inputs);
  assert.equal(diff.length, 4);
  assert.equal(diff[1].before, "");
  assert.equal(diff[1].after, "49.96");
  console.log("PASS  зміни записано, у журналі видно було і стане");

  const out = await loadWorkbook(await blob.arrayBuffer());
  const ws = out.getWorksheet("Постачальники");
  assert.ok(ws);
  assert.equal(ws.getCell("B2").value, "Агроль");
  assert.equal(ws.getCell("H2").value, 49.96, "координата має стати числом");
  assert.equal(ws.getCell("N3").value, 120);
  console.log("PASS  значення полів вводу збережено, числа записано числами");

  const q2 = ws.getCell("Q2").value;
  assert.ok(typeof q2 === "object" && q2 !== null && "formula" in q2, "формула має лишитися формулою");
  const after = await inspectXlsx(await blob.arrayBuffer());
  const afterSheet = after.find((s) => s.name === "Постачальники");
  assert.equal(afterSheet?.formulas, 240);
  assert.equal(afterSheet?.validations, 6, "правила валідації мають лишитися без дублів");
  assert.equal(afterSheet?.conditionals, 1);
  console.log("PASS  формули, валідація (6 правил) і умовне форматування збережені");

  const orig = await loadWorkbook(original);
  const changed = new Set(changes.map((c) => `${c.sheet}!${c.ref}`));
  let otherDiffs = 0;
  for (const wsO of orig.worksheets) {
    const wsN = out.getWorksheet(wsO.name);
    assert.ok(wsN, `аркуш ${wsO.name} зник`);
    for (let r = 1; r <= wsO.rowCount; r++) {
      for (let c = 1; c <= wsO.columnCount; c++) {
        const ref = `${wsO.name}!${String.fromCharCode(64 + c)}${r}`;
        if (changed.has(ref)) continue;
        if (textOf(wsO.getCell(r, c).value) !== textOf(wsN.getCell(r, c).value)) otherDiffs++;
      }
    }
  }
  assert.equal(otherDiffs, 0, "жодна інша клітинка не має змінитись");
  console.log("PASS  жодна інша клітинка не змінилась");

  const bad: [string, CellChange[], RegExp][] = [
    ["не поле вводу", [{ sheet: "Постачальники", ref: "A2", value: "x" }], /не позначено як поле вводу/],
    ["заголовок", [{ sheet: "Постачальники", ref: "H1", value: "x" }], /заголовки/],
    ["невідомий аркуш", [{ sheet: "Немає", ref: "H2", value: "x" }], /не знайдено/],
    ["некоректна адреса", [{ sheet: "Постачальники", ref: "2H", value: "x" }], /Некоректна адреса/],
  ];
  // Формула відхиляється навіть тоді, коли її стовпець позначено як поле вводу.
  await assert.rejects(
    () =>
      applyChanges(original, [{ sheet: "Постачальники", ref: "Q2", value: "x" }], {
        "Постачальники": [...inputs["Постачальники"], "Q"],
      }),
    /формулу/
  );
  console.log("PASS  відхилено: формула, навіть у дозволеному стовпці");

  for (const [label, list, pattern] of bad) {
    await assert.rejects(() => applyChanges(original, list, inputs), pattern);
    console.log(`PASS  відхилено: ${label}`);
  }
}

main().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});

// Перевірка інструмента fill_xlsx: коректний ввід дає зміни, некоректний дає пояснення.
import { runFillXlsx } from "../lib/xlsx/fill-tool";
(async () => {
  const spec = JSON.parse(readFileSync("lib/xlsx/examples/suppliers.spec.json", "utf8"));
  const made = await runCreateXlsx(spec);
  if (!made.ok) throw new Error(made.error);
  const buf = await made.blob.arrayBuffer();
  const ok = await runFillXlsx(
    { inputColumns: { "Постачальники": ["B"] }, changes: [{ sheet: "Постачальники", ref: "B3", value: "Тест" }] },
    buf
  );
  assert.ok(ok.ok, !ok.ok ? ok.error : "");
  assert.equal(ok.diff[0].after, "Тест");
  const bad = await runFillXlsx({ inputColumns: {} }, buf);
  assert.ok(!bad.ok);
  console.log("PASS  fill_xlsx: коректний ввід дає зміни, некоректний дає пояснення");
})().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
