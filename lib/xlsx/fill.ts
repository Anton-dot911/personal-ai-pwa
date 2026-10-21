import ExcelJS from "exceljs";
import { coerceCell, type ColumnKind } from "./write";
import type { CellValue } from "./schema";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
type LoadArg = Parameters<ExcelJS.Workbook["xlsx"]["load"]>[0];

export interface CellChange {
  sheet: string;
  /** Адреса клітинки, наприклад H5. Рядок 1 це заголовки і не змінюється. */
  ref: string;
  value: CellValue;
}

export interface ColumnInfo {
  letter: string;
  header: string;
  formulas: number;
  numFmt: string;
  sample: string;
}

export interface SheetInfo {
  name: string;
  dataRows: number;
  columns: ColumnInfo[];
  validations: number;
  conditionals: number;
  formulas: number;
}

export interface DiffEntry {
  sheet: string;
  ref: string;
  header: string;
  before: string;
  after: string;
}

interface Cell {
  row: number;
  col: number;
}

function fail(message: string): never {
  throw new Error(message);
}

export function colLetter(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

export function colNumber(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function isFormulaValue(v: unknown): boolean {
  return typeof v === "object" && v !== null && "formula" in v;
}

export function textOf(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (isFormulaValue(v)) return `=${(v as { formula: string }).formula}`;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object" && "richText" in (v as object)) {
    return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join("");
  }
  return String(v);
}

function kindOf(numFmt: string): ColumnKind | undefined {
  if (!numFmt || numFmt === "General") return undefined;
  if (/[dy]/i.test(numFmt) && !/[#0]/.test(numFmt.replace(/\[[^\]]*\]/g, ""))) return "date";
  if (/[0#]/.test(numFmt)) return "number";
  return undefined;
}

// Розбирає sqref з ExcelJS, наприклад "H2:H121" або "H2:H5 J7", на окремі клітинки.
function parseSqref(sqref: string): Cell[] {
  const cells: Cell[] = [];
  for (const part of sqref.trim().split(/\s+/)) {
    const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(part);
    if (!m) continue;
    const c1 = colNumber(m[1]);
    const r1 = Number(m[2]);
    const c2 = m[3] ? colNumber(m[3]) : c1;
    const r2 = m[4] ? Number(m[4]) : r1;
    for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
      for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) cells.push({ row: r, col: c });
    }
  }
  return cells;
}

function validationModel(ws: ExcelJS.Worksheet): Record<string, unknown> {
  return (ws as unknown as { dataValidations: { model: Record<string, unknown> } }).dataValidations.model;
}

function ruleSignature(rule: object): string {
  return JSON.stringify(rule, Object.keys(rule).sort());
}

// Правило валідації, яке діє на клітинку. Повертає nullish, якщо правила немає.
function ruleFor(ws: ExcelJS.Worksheet, cell: Cell): Record<string, unknown> | undefined {
  for (const [sqref, rule] of Object.entries(validationModel(ws))) {
    if (typeof rule !== "object" || rule === null) continue;
    if (parseSqref(sqref).some((c) => c.row === cell.row && c.col === cell.col)) {
      return rule as Record<string, unknown>;
    }
  }
  return undefined;
}

// ExcelJS при читанні дублює правила: один і той самий діапазон з'являється двічі, зокрема
// з іншим початком (H2:H121 і H10:H121). Тут правила групуються за змістом, а кожен
// діапазон записується один раз.
function normalizeValidations(ws: ExcelJS.Worksheet): void {
  const model = validationModel(ws);
  const groups = new Map<string, { rule: object; cells: Map<string, Cell> }>();
  for (const [sqref, rule] of Object.entries(model)) {
    if (typeof rule !== "object" || rule === null) continue;
    const sig = ruleSignature(rule);
    const group = groups.get(sig) ?? { rule, cells: new Map<string, Cell>() };
    for (const c of parseSqref(sqref)) group.cells.set(`${c.row}:${c.col}`, c);
    groups.set(sig, group);
  }
  if (groups.size === 0) return;

  const holder = ws as unknown as {
    dataValidations: { model: Record<string, unknown>; add: (ref: string, rule: unknown) => void };
  };
  holder.dataValidations.model = {};
  for (const { rule, cells } of groups.values()) {
    const list = [...cells.values()];
    const r1 = Math.min(...list.map((c) => c.row));
    const r2 = Math.max(...list.map((c) => c.row));
    const c1 = Math.min(...list.map((c) => c.col));
    const c2 = Math.max(...list.map((c) => c.col));
    const isRect = (r2 - r1 + 1) * (c2 - c1 + 1) === list.length;
    if (isRect) {
      holder.dataValidations.add(`${colLetter(c1)}${r1}:${colLetter(c2)}${r2}`, rule);
    } else {
      for (const c of list) holder.dataValidations.add(`${colLetter(c.col)}${c.row}`, rule);
    }
  }
}

// Кількість окремих правил: однакові за змістом правила рахуються один раз.
function countRules(ws: ExcelJS.Worksheet): number {
  const sigs = new Set<string>();
  for (const rule of Object.values(validationModel(ws))) {
    if (typeof rule === "object" && rule !== null) sigs.add(ruleSignature(rule));
  }
  return sigs.size;
}

export async function loadWorkbook(buffer: ArrayBuffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as LoadArg);
  for (const ws of wb.worksheets) normalizeValidations(ws);
  return wb;
}

export async function inspectXlsx(buffer: ArrayBuffer): Promise<SheetInfo[]> {
  const wb = await loadWorkbook(buffer);
  return wb.worksheets.map((ws) => {
    const columns: ColumnInfo[] = [];
    let formulas = 0;
    for (let c = 1; c <= ws.columnCount; c++) {
      let colFormulas = 0;
      for (let r = 2; r <= ws.rowCount; r++) {
        if (isFormulaValue(ws.getCell(r, c).value)) colFormulas++;
      }
      formulas += colFormulas;
      const sample = ws.getCell(2, c);
      columns.push({
        letter: colLetter(c),
        header: textOf(ws.getCell(1, c).value),
        formulas: colFormulas,
        numFmt: sample.numFmt || "General",
        sample: textOf(sample.value),
      });
    }
    return {
      name: ws.name,
      dataRows: Math.max(0, ws.rowCount - 1),
      columns,
      validations: countRules(ws),
      conditionals: (ws as unknown as { conditionalFormattings: unknown[] }).conditionalFormattings.length,
      formulas,
    };
  });
}

// Змінює лише дозволені поля вводу. Формули, заголовки й інші клітинки не змінюються.
export async function applyChanges(
  buffer: ArrayBuffer,
  changes: CellChange[],
  inputColumns: Record<string, string[]>
): Promise<{ blob: Blob; diff: DiffEntry[] }> {
  const wb = await loadWorkbook(buffer);
  const diff: DiffEntry[] = [];

  for (const change of changes) {
    const ws = wb.getWorksheet(change.sheet);
    if (!ws) fail(`Аркуш «${change.sheet}» не знайдено.`);

    const m = /^([A-Z]{1,3})([1-9]\d*)$/.exec(change.ref);
    if (!m) fail(`Некоректна адреса «${change.ref}».`);
    const letter = m[1];
    const row = Number(m[2]);
    const col = colNumber(letter);

    if (row < 2) fail(`${change.ref}: рядок 1 містить заголовки, їх змінювати не можна.`);
    const allowed = inputColumns[change.sheet] ?? [];
    if (!allowed.includes(letter)) {
      fail(`Стовпець ${letter} не позначено як поле вводу на аркуші «${change.sheet}».`);
    }

    const cell = ws.getCell(row, col);
    if (isFormulaValue(cell.value)) fail(`${change.ref}: клітинка містить формулу, її змінювати не можна.`);

    const rule = ruleFor(ws, { row, col });
    const ruleType = rule ? (rule as { type?: string }).type : undefined;
    const kind =
      kindOf(cell.numFmt) ??
      (ruleType === "decimal" || ruleType === "whole" ? "number" : ruleType === "date" ? "date" : undefined);

    const header = textOf(ws.getCell(1, col).value);
    const before = textOf(cell.value);
    cell.value = coerceCell(change.value, kind) as ExcelJS.CellValue;
    diff.push({ sheet: change.sheet, ref: change.ref, header, before, after: textOf(cell.value) });
  }

  const out = await wb.xlsx.writeBuffer();
  return { blob: new Blob([out], { type: XLSX_MIME }), diff };
}
