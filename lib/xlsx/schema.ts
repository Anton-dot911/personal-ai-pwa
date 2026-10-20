// Опис таблиці, яку застосунок перетворює на .xlsx.
// Claude формує цей JSON через інструмент, а файл створюється у браузері.

/** Колір у форматі ARGB, наприклад "FF1F3864". */
export type ArgbColor = string;

export interface CellStyle {
  fontName?: string;
  fill?: ArgbColor;
  fontColor?: ArgbColor;
  bold?: boolean;
  size?: number;
  numFmt?: string;
  wrap?: boolean;
}

export interface ColumnSpec {
  width?: number;
  /** "input" позначає поля вводу: їх заповнює користувач у режимі заповнення шаблону. */
  role?: "input" | "info";
  headerStyle?: CellStyle;
  cellStyle?: CellStyle;
}

export interface CellFormula {
  /** Текст формули без знака "=", англійські назви функцій, розділювач — кома. */
  formula: string;
  /** Обчислене значення, яке бачить користувач до перерахунку. */
  result?: string | number | boolean;
}

export type CellValue = string | number | boolean | null | CellFormula;

export interface ValidationSpec {
  ref: string;
  type: "decimal" | "whole" | "list" | "time" | "date";
  operator?: "between" | "greaterThan" | "lessThan" | "equal";
  /** Для list: ['"Так,Ні"']. Для decimal/whole/time: межі, наприклад [44, 53.5]. */
  formulae: (string | number)[];
  allowBlank?: boolean;
  error?: string;
  errorTitle?: string;
}

export interface ConditionalRule {
  /** Формула відносно верхньої лівої клітинки діапазону, наприклад Q2="ок". */
  formula: string;
  fill?: ArgbColor;
  fontColor?: ArgbColor;
}

export interface ConditionalSpec {
  ref: string;
  rules: ConditionalRule[];
}

/** Стиль конкретної клітинки. Замінює стиль стовпця повністю. */
export interface CellStyleOverride {
  ref: string;
  style: CellStyle;
}

export interface SheetSpec {
  name: string;
  font?: { name: string; size: number };
  columns?: ColumnSpec[];
  /** Рядок 0 це заголовки, якщо вони є. */
  rows: CellValue[][];
  cellStyles?: CellStyleOverride[];
  /** Клітинка, з якої починається прокрутка, наприклад "A2" або "C2". */
  freeze?: string;
  autoFilter?: string;
  validations?: ValidationSpec[];
  conditionals?: ConditionalSpec[];
}

export interface WorkbookSpec {
  filename?: string;
  sheets: SheetSpec[];
}
