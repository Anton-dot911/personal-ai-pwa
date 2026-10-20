import ExcelJS from "exceljs";
import type {
  CellStyle,
  CellValue,
  ColumnSpec,
  SheetSpec,
  WorkbookSpec,
} from "./schema";

const DEFAULT_FONT = { name: "Arial", size: 10 };
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function isFormula(value: CellValue): value is { formula: string; result?: string | number | boolean } {
  return typeof value === "object" && value !== null && "formula" in value;
}

// "C2" -> { col: 3, row: 2 }
function parseRef(ref: string): { col: number; row: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new Error(`Некоректна адреса клітинки: ${ref}`);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col, row: Number(m[2]) };
}

// ExcelJS вважає ширину 9 стандартною і не записує її. Тисячна частина символа непомітна.
function excelWidth(width: number): number {
  return width === 9 ? 9.001 : width;
}

function applyStyle(
  cell: ExcelJS.Cell,
  style: CellStyle,
  font: { name: string; size: number }
): void {
  cell.font = {
    name: style.fontName ?? font.name,
    size: style.size ?? font.size,
    bold: style.bold ?? false,
    color: style.fontColor ? { argb: style.fontColor } : undefined,
  };
  if (style.fill) {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: style.fill } };
  }
  if (style.numFmt) cell.numFmt = style.numFmt;
  if (style.wrap) cell.alignment = { wrapText: true, vertical: "top" };
}

function buildSheet(wb: ExcelJS.Workbook, spec: SheetSpec): void {
  const ws = wb.addWorksheet(spec.name);
  const font = spec.font ?? DEFAULT_FONT;
  const columns: ColumnSpec[] = spec.columns ?? [];

  columns.forEach((c, i) => {
    if (c.width) ws.getColumn(i + 1).width = excelWidth(c.width);
  });

  const overrides = new Map((spec.cellStyles ?? []).map((o) => [o.ref, o.style]));

  spec.rows.forEach((row, r) => {
    row.forEach((value, c) => {
      const cell = ws.getCell(r + 1, c + 1);
      if (isFormula(value)) {
        cell.value =
          value.result === undefined
            ? { formula: value.formula }
            : { formula: value.formula, result: value.result };
      } else if (value !== null) {
        cell.value = value;
      }
      const column = columns[c];
      const base = r === 0 ? column?.headerStyle : column?.cellStyle;
      applyStyle(cell, overrides.get(cell.address) ?? base ?? {}, font);
    });
  });

  if (spec.freeze) {
    const { col, row } = parseRef(spec.freeze);
    ws.views = [
      {
        state: "frozen",
        xSplit: col - 1,
        ySplit: row - 1,
        topLeftCell: spec.freeze,
        activeCell: spec.freeze,
      },
    ];
  }

  if (spec.autoFilter) ws.autoFilter = spec.autoFilter;

  for (const v of spec.validations ?? []) {
    // Тип "time" ExcelJS у типах не описує, тому приведення через unknown.
    const rule = {
      type: v.type,
      operator: v.operator ?? "between",
      formulae: v.formulae,
      allowBlank: v.allowBlank ?? true,
      showErrorMessage: true,
      errorStyle: "stop", // єдине значення для помилки у стандарті OOXML (інші: warning, information)
      errorTitle: v.errorTitle,
      error: v.error,
    };
    // Типи ExcelJS не описують dataValidations на аркуші, тому доступ через приведення типу.
    (ws as unknown as { dataValidations: { add: (ref: string, rule: unknown) => void } })
      .dataValidations.add(v.ref, rule);
  }

  let priority = 1;
  for (const c of spec.conditionals ?? []) {
    ws.addConditionalFormatting({
      ref: c.ref,
      rules: c.rules.map((r) => ({
        type: "expression" as const,
        formulae: [r.formula],
        priority: priority++,
        style: {
          ...(r.fill
            ? { fill: { type: "pattern" as const, pattern: "solid" as const, bgColor: { argb: r.fill } } }
            : {}),
          ...(r.fontColor ? { font: { color: { argb: r.fontColor } } } : {}),
        },
      })),
    });
  }
}

export function buildWorkbook(spec: WorkbookSpec): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  // Excel перерахує формули при відкритті, навіть якщо кешовані значення застаріли.
  wb.calcProperties.fullCalcOnLoad = true;
  for (const sheet of spec.sheets) buildSheet(wb, sheet);
  return wb;
}

export async function workbookToBlob(spec: WorkbookSpec): Promise<Blob> {
  const buffer = await buildWorkbook(spec).xlsx.writeBuffer();
  return new Blob([buffer], { type: XLSX_MIME });
}
