// Перевірка рушія: збирає .xlsx з опису зразка.
// Запуск з кореня проєкту: npx tsx scripts/xlsx-roundtrip.ts вихідний.xlsx
import { readFileSync, writeFileSync } from "node:fs";
import { buildWorkbook } from "../lib/xlsx/write";
import type { WorkbookSpec } from "../lib/xlsx/schema";

async function main(): Promise<void> {
  const outPath = process.argv[2] ?? "generated.xlsx";
  const spec = JSON.parse(
    readFileSync("lib/xlsx/examples/suppliers.spec.json", "utf8")
  ) as WorkbookSpec;
  const buffer = await buildWorkbook(spec).xlsx.writeBuffer();
  writeFileSync(outPath, Buffer.from(buffer));
  console.log(`записано: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
