import type { ToolDef } from "../anthropic";
import type { CellValue, SheetSpec, WorkbookSpec } from "./schema";

export const MAX_TOOL_STEPS = 3;

const MAX_SHEETS = 10;
const MAX_ROWS = 5000;
const MAX_COLS = 100;
const MAX_CELLS = 50000;

const CELL_RE = /^[A-Z]{1,3}[1-9][0-9]*$/;
const RANGE_RE = /^[A-Z]{1,3}[1-9][0-9]*(:[A-Z]{1,3}[1-9][0-9]*)?$/;
const COLOR_RE = /^[0-9A-F]{8}$/;
const FORBIDDEN_NAME = /[[\]:*?/\\]/;
const VALID_TYPES = ["decimal", "whole", "list", "time", "date"];

// Інструкція для моделі: коли викликати інструмент і як писати таблиці.
export const XLSX_GUIDANCE =
  "Коли користувач просить таблицю, журнал, шаблон або звіт в Excel, викликай інструмент create_xlsx. " +
  "Файл створюється один раз, тому опиши його повністю: усі аркуші, заголовки, рядки, формули і правила. " +
  "Назви аркушів, заголовків і підказки пиши українською. Формули пиши англійськими назвами функцій " +
  "з комами, наприклад =SUM(B2:B3). Поля, які заповнює людина, позначай role: \"input\". " +
  "Якщо користувач просить лише текст, не створюй файл.";

const STYLE_SCHEMA = {
  type: "object",
  properties: {
    fontName: { type: "string" },
    fill: { type: "string", description: "Колір ARGB, наприклад FF1F3864" },
    fontColor: { type: "string", description: "Колір ARGB, наприклад FFFFFFFF" },
    bold: { type: "boolean" },
    size: { type: "number" },
    numFmt: { type: "string", description: "Числовий формат Excel, наприклад #,##0.00 або dd.mm.yyyy" },
    wrap: { type: "boolean" },
  },
};

const RANGE_PATTERN = "^[A-Z]{1,3}[1-9][0-9]*(:[A-Z]{1,3}[1-9][0-9]*)?$";
const CELL_PATTERN = "^[A-Z]{1,3}[1-9][0-9]*$";

export const CREATE_XLSX_TOOL: ToolDef = {
  name: "create_xlsx",
  description:
    "Створює файл .xlsx за описом аркушів. Рядок 0 у rows це заголовки. " +
    "Клітинка може бути текстом, числом, логічним значенням, null або формулою {formula, result}. " +
    "Валідація даних (list, decimal, whole, time, date) і умовне форматування задаються окремими полями.",
  input_schema: {
    type: "object",
    properties: {
      filename: { type: "string", description: "Назва файлу, наприклад budget_q1.xlsx" },
      sheets: {
        type: "array",
        minItems: 1,
        maxItems: MAX_SHEETS,
        items: {
          type: "object",
          required: ["name", "rows"],
          properties: {
            name: { type: "string", maxLength: 31 },
            font: {
              type: "object",
              properties: { name: { type: "string" }, size: { type: "number" } },
            },
            columns: {
              type: "array",
              maxItems: MAX_COLS,
              items: {
                type: "object",
                properties: {
                  width: { type: "number" },
                  role: { type: "string", enum: ["input", "info"] },
                  headerStyle: STYLE_SCHEMA,
                  cellStyle: STYLE_SCHEMA,
                },
              },
            },
            rows: {
              type: "array",
              maxItems: MAX_ROWS,
              items: {
                type: "array",
                items: {
                  anyOf: [
                    { type: "string" },
                    { type: "number" },
                    { type: "boolean" },
                    { type: "null" },
                    {
                      type: "object",
                      required: ["formula"],
                      properties: {
                        formula: { type: "string" },
                        result: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
                      },
                    },
                  ],
                },
              },
            },
            cellStyles: {
              type: "array",
              items: {
                type: "object",
                required: ["ref", "style"],
                properties: { ref: { type: "string", pattern: CELL_PATTERN }, style: STYLE_SCHEMA },
              },
            },
            freeze: { type: "string", pattern: CELL_PATTERN, description: "Наприклад A2 для закріплення заголовка" },
            autoFilter: { type: "string", pattern: RANGE_PATTERN, description: "Наприклад A1:D20" },
            validations: {
              type: "array",
              items: {
                type: "object",
                required: ["ref", "type", "formulae"],
                properties: {
                  ref: { type: "string", pattern: RANGE_PATTERN },
                  type: { type: "string", enum: VALID_TYPES },
                  operator: { type: "string", enum: ["between", "greaterThan", "lessThan", "equal"] },
                  formulae: {
                    type: "array",
                    minItems: 1,
                    maxItems: 2,
                    items: { anyOf: [{ type: "string" }, { type: "number" }] },
                    description: 'Для list: ["\\"Так,Ні\\""]. Для decimal, whole, time: межі, наприклад [0, 600]',
                  },
                  allowBlank: { type: "boolean" },
                  error: { type: "string" },
                  errorTitle: { type: "string" },
                },
              },
            },
            conditionals: {
              type: "array",
              items: {
                type: "object",
                required: ["ref", "rules"],
                properties: {
                  ref: { type: "string", pattern: RANGE_PATTERN },
                  rules: {
                    type: "array",
                    maxItems: 20,
                    items: {
                      type: "object",
                      required: ["formula"],
                      properties: {
                        formula: { type: "string", description: 'Відносно верхньої клітинки, наприклад Q2="ок"' },
                        fill: { type: "string" },
                        fontColor: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    required: ["sheets"],
  },
};

function fail(message: string): never {
  throw new Error(message);
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkColor(value: unknown, where: string): void {
  if (value !== undefined && (typeof value !== "string" || !COLOR_RE.test(value))) {
    fail(`${where}: колір має бути у форматі ARGB, наприклад FF1F3864`);
  }
}

function checkStyle(value: unknown, where: string): void {
  if (value === undefined) return;
  if (!isObj(value)) fail(`${where}: стиль має бути об'єктом`);
  checkColor(value.fill, `${where}, заливка`);
  checkColor(value.fontColor, `${where}, колір шрифта`);
  if (value.numFmt !== undefined && (typeof value.numFmt !== "string" || value.numFmt.length > 64)) {
    fail(`${where}: некоректний числовий формат`);
  }
  if (value.size !== undefined && (typeof value.size !== "number" || value.size < 6 || value.size > 72)) {
    fail(`${where}: розмір шрифта має бути від 6 до 72`);
  }
}

function checkRef(value: unknown, where: string, re: RegExp): void {
  if (typeof value !== "string" || !re.test(value)) fail(`${where}: некоректна адреса «${String(value)}»`);
}

function checkCell(value: unknown, where: string): void {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return;
  }
  if (isObj(value) && typeof value.formula === "string") {
    if (!value.formula.trim() || value.formula.startsWith("=")) {
      fail(`${where}: формула має бути непорожньою і без знака "="`);
    }
    if (value.formula.length > 8000) fail(`${where}: формула задовга`);
    return;
  }
  fail(`${where}: недопустиме значення клітинки`);
}

// Перевірка структури до створення файлу. Помилка повертається моделі, і вона може виправити виклик.
export function validateWorkbookSpec(input: unknown): WorkbookSpec {
  if (!isObj(input) || !Array.isArray(input.sheets)) fail("Потрібен список аркушів (sheets).");
  const rawSheets = input.sheets as unknown[];
  if (rawSheets.length < 1 || rawSheets.length > MAX_SHEETS) {
    fail(`Аркушів має бути від 1 до ${MAX_SHEETS}.`);
  }

  const names = new Set<string>();
  let totalCells = 0;

  const sheets = rawSheets.map((raw, i): SheetSpec => {
    const label = `Аркуш ${i + 1}`;
    if (!isObj(raw)) fail(`${label}: має бути об'єктом`);
    const s = raw;
    if (typeof s.name !== "string" || !s.name.trim()) fail(`${label}: потрібна назва`);
    const name = s.name.trim();
    if (name.length > 31) fail(`${label}: назва «${name}» довша за 31 символ`);
    if (FORBIDDEN_NAME.test(name)) fail(`${label}: у назві не можна використовувати символи [ ] : * ? / \\`);
    if (names.has(name.toLowerCase())) fail(`Назва аркуша «${name}» повторюється`);
    names.add(name.toLowerCase());

    if (!Array.isArray(s.rows)) fail(`${label} («${name}»): потрібен масив rows`);
    const rows = s.rows as unknown[];
    if (rows.length > MAX_ROWS) fail(`${label}: більше ${MAX_ROWS} рядків`);
    rows.forEach((row, r) => {
      if (!Array.isArray(row)) fail(`${label}, рядок ${r + 1}: має бути масивом клітинок`);
      const cells = row as unknown[];
      if (cells.length > MAX_COLS) fail(`${label}, рядок ${r + 1}: більше ${MAX_COLS} стовпців`);
      cells.forEach((cell, c) => checkCell(cell, `${label}, рядок ${r + 1}, стовпець ${c + 1}`));
      totalCells += cells.length;
    });
    if (totalCells > MAX_CELLS) fail(`Забагато клітинок (понад ${MAX_CELLS}).`);

    if (s.columns !== undefined) {
      if (!Array.isArray(s.columns) || s.columns.length > MAX_COLS) fail(`${label}: некоректний список стовпців`);
      (s.columns as unknown[]).forEach((col, c) => {
        const where = `${label}, стовпець ${c + 1}`;
        if (!isObj(col)) fail(`${where}: має бути об'єктом`);
        if (col.width !== undefined && (typeof col.width !== "number" || col.width < 1 || col.width > 255)) {
          fail(`${where}: ширина має бути від 1 до 255`);
        }
        if (col.role !== undefined && col.role !== "input" && col.role !== "info") {
          fail(`${where}: role має бути input або info`);
        }
        checkStyle(col.headerStyle, `${where}, заголовок`);
        checkStyle(col.cellStyle, `${where}, клітинки`);
      });
    }

    if (s.cellStyles !== undefined) {
      if (!Array.isArray(s.cellStyles)) fail(`${label}: cellStyles має бути масивом`);
      (s.cellStyles as unknown[]).forEach((o) => {
        if (!isObj(o)) fail(`${label}: елемент cellStyles має бути об'єктом`);
        checkRef(o.ref, `${label}, cellStyles`, CELL_RE);
        checkStyle(o.style, `${label}, cellStyles ${String(o.ref)}`);
      });
    }

    if (s.freeze !== undefined) checkRef(s.freeze, `${label}, freeze`, CELL_RE);
    if (s.autoFilter !== undefined) checkRef(s.autoFilter, `${label}, autoFilter`, RANGE_RE);

    if (s.validations !== undefined) {
      if (!Array.isArray(s.validations)) fail(`${label}: validations має бути масивом`);
      (s.validations as unknown[]).forEach((v) => {
        if (!isObj(v)) fail(`${label}: правило валідації має бути об'єктом`);
        checkRef(v.ref, `${label}, валідація`, RANGE_RE);
        if (typeof v.type !== "string" || !VALID_TYPES.includes(v.type)) {
          fail(`${label}, валідація ${String(v.ref)}: тип має бути одним з ${VALID_TYPES.join(", ")}`);
        }
        if (!Array.isArray(v.formulae) || v.formulae.length < 1 || v.formulae.length > 2) {
          fail(`${label}, валідація ${String(v.ref)}: formulae має містити 1 або 2 значення`);
        }
      });
    }

    if (s.conditionals !== undefined) {
      if (!Array.isArray(s.conditionals)) fail(`${label}: conditionals має бути масивом`);
      (s.conditionals as unknown[]).forEach((c) => {
        if (!isObj(c)) fail(`${label}: правило умовного форматування має бути об'єктом`);
        checkRef(c.ref, `${label}, умовне форматування`, RANGE_RE);
        if (!Array.isArray(c.rules) || c.rules.length < 1 || c.rules.length > 20) {
          fail(`${label}, умовне форматування ${String(c.ref)}: від 1 до 20 правил`);
        }
        (c.rules as unknown[]).forEach((rule) => {
          if (!isObj(rule) || typeof rule.formula !== "string" || !rule.formula.trim()) {
            fail(`${label}, умовне форматування ${String(c.ref)}: потрібна формула правила`);
          }
          checkColor(rule.fill, `${label}, умовне форматування, заливка`);
          checkColor(rule.fontColor, `${label}, умовне форматування, колір шрифта`);
        });
      });
    }

    return s as unknown as SheetSpec;
  });

  const filename = typeof input.filename === "string" ? input.filename : undefined;
  return { filename, sheets };
}

function safeFilename(name: string | undefined): string {
  const base = (name ?? "table").replace(/[\\/:*?"<>|]/g, "_").trim() || "table";
  return base.toLowerCase().endsWith(".xlsx") ? base : `${base}.xlsx`;
}

export type ToolRun =
  | { ok: true; name: string; blob: Blob; summary: string }
  | { ok: false; error: string };

// Виконує виклик create_xlsx: перевіряє опис, будує файл і повертає текст для моделі.
export async function runCreateXlsx(input: unknown): Promise<ToolRun> {
  try {
    const spec = validateWorkbookSpec(input);
    // Бібліотека завантажується лише тоді, коли вона справді потрібна.
    const { workbookToBlob } = await import("./write");
    const blob = await workbookToBlob(spec);
    const name = safeFilename(spec.filename);
    const rowCount = spec.sheets.reduce((n, sheet) => n + sheet.rows.length, 0);
    return {
      ok: true,
      name,
      blob,
      summary: `Файл «${name}» створено. Аркушів: ${spec.sheets.length}, рядків: ${rowCount}. Користувач може завантажити його з чату.`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Не вдалося створити файл." };
  }
}

export type { CellValue };
