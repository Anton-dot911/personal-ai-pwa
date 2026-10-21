import type { ToolDef } from "../anthropic";
import type { CellChange, DiffEntry, SheetInfo } from "./fill";
import type { CellValue } from "./schema";

export const FILL_XLSX_TOOL: ToolDef = {
  name: "fill_xlsx",
  description:
    "Заповнює поля вводу в таблиці, яку завантажив користувач. Вказуй тільки стовпці, які заповнює людина " +
    "(inputColumns, за назвами аркушів), і нові значення (changes). Формули, заголовки й інші клітинки не змінюються. " +
    "Зміни спершу показуються користувачеві, файл створиться лише після його підтвердження.",
  input_schema: {
    type: "object",
    properties: {
      inputColumns: {
        type: "object",
        description: 'Назва аркуша → літери стовпців, наприклад {"Постачальники": ["B", "H", "I"]}',
        additionalProperties: { type: "array", items: { type: "string" } },
      },
      changes: {
        type: "array",
        maxItems: 500,
        items: {
          type: "object",
          required: ["sheet", "ref", "value"],
          properties: {
            sheet: { type: "string" },
            ref: { type: "string", description: "Адреса клітинки, наприклад H5. Рядок 1 не змінюється." },
            value: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }] },
          },
        },
      },
    },
    required: ["inputColumns", "changes"],
  },
};

// Текстовий опис таблиці для моделі: аркуші, стовпці, приклади і формули.
export function describeUpload(name: string, sheets: SheetInfo[]): string {
  const lines = [
    `Користувач завантажив таблицю «${name}». Щоб змінити її, викликай fill_xlsx. Формули не змінюй.`,
    "Аркуші:",
  ];
  for (const s of sheets) {
    lines.push(`- ${s.name} (рядків даних: ${s.dataRows}, формул: ${s.formulas}, правил валідації: ${s.validations})`);
    for (const c of s.columns) {
      if (!c.header) continue;
      const formula = c.formulas > 0 ? ` (формула в ${c.formulas} рядках)` : "";
      lines.push(`  ${c.letter}: «${c.header}», приклад: ${c.sample || "порожньо"}${formula}`);
    }
  }
  return lines.join("\n");
}

export type FillRun =
  | { ok: true; blob: Blob; diff: DiffEntry[]; summary: string }
  | { ok: false; error: string };

function fail(message: string): never {
  throw new Error(message);
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Виконує виклик fill_xlsx над завантаженою таблицею і повертає підготовлені зміни.
export async function runFillXlsx(input: unknown, buffer: ArrayBuffer): Promise<FillRun> {
  try {
    if (!isObj(input) || !isObj(input.inputColumns) || !Array.isArray(input.changes)) {
      fail("Потрібні поля inputColumns і changes.");
    }
    const inputColumns: Record<string, string[]> = {};
    for (const [sheet, cols] of Object.entries(input.inputColumns)) {
      if (!Array.isArray(cols) || cols.some((c) => typeof c !== "string" || !/^[A-Z]{1,3}$/.test(c))) {
        fail(`Для аркуша «${sheet}» літери стовпців мають бути на кшталт B або AA.`);
      }
      inputColumns[sheet] = cols as string[];
    }

    const changes: CellChange[] = input.changes.map((raw, i) => {
      if (!isObj(raw) || typeof raw.sheet !== "string" || typeof raw.ref !== "string") {
        fail(`Зміна ${i + 1}: потрібні sheet і ref.`);
      }
      const value = raw.value;
      if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        fail(`Зміна ${i + 1}: value має бути текстом, числом, логічним значенням або null.`);
      }
      return { sheet: raw.sheet, ref: raw.ref, value: value as CellValue };
    });
    if (changes.length === 0) fail("Немає жодної зміни.");
    if (changes.length > 500) fail("Забагато змін за один раз (понад 500).");

    // Бібліотека завантажується лише тоді, коли потрібно змінити таблицю.
    const { applyChanges } = await import("./fill");
    const { blob, diff } = await applyChanges(buffer, changes, inputColumns);
    return {
      ok: true,
      blob,
      diff,
      summary: `Підготовлено змін: ${diff.length}. Файл створиться після підтвердження користувачем.`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Не вдалося підготувати зміни." };
  }
}
