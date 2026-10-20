import fs from "node:fs";
import { stringify } from "csv-stringify/sync";
import { z } from "zod";
import { FlowBridgeError } from "../lib/errors.js";
import { getPath, toCell, toRows, type Row } from "../lib/fields.js";
import { ensureParentDir, resolveInside } from "../lib/safe-path.js";
import type { RuntimeContext, StepOutput } from "../types.js";

const baseId = z.string().regex(/^[A-Za-z0-9_-]+$/, "id may only contain letters, digits, - and _");
const field = z.union([z.string().min(1), z.strictObject({ path: z.string().min(1), header: z.string().min(1) })]);

export const csvSchema = z.strictObject({
  id: baseId,
  type: z.literal("csv"),
  continueOnError: z.boolean().optional(),
  input: z.string().min(1),
  output: z.string().min(1),
  /** Columns to export; each is a dotted path or {path, header}. Defaults to every top-level key. */
  fields: z.array(field).optional(),
  delimiter: z.enum([",", ";", "\t", "|"]).default(","),
  /** Prefix cells starting with = + - @ so spreadsheets don't evaluate them as formulas. */
  sanitizeFormulas: z.boolean().default(true),
});
export type CsvStep = z.infer<typeof csvSchema>;

export const jsonSchema = z.strictObject({
  id: baseId,
  type: z.literal("json"),
  continueOnError: z.boolean().optional(),
  input: z.string().min(1),
  output: z.string().min(1),
  fields: z.array(field).optional(),
  pretty: z.boolean().default(true),
});
export type JsonStep = z.infer<typeof jsonSchema>;

function columns(rows: Row[], fields: z.infer<typeof field>[] | undefined) {
  if (fields) return fields.map((f) => (typeof f === "string" ? { path: f, header: f } : f));
  const keys = new Set<string>();
  rows.forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
  return [...keys].map((k) => ({ path: k, header: k }));
}

function prepare(step: CsvStep | JsonStep, input: unknown): Row[] {
  try {
    return toRows(input, `input "${step.input}"`);
  } catch (e) {
    throw new FlowBridgeError("INPUT_INVALID", (e as Error).message);
  }
}

function write(ctx: RuntimeContext, output: string, content: string): string {
  const file = resolveInside(ctx.rootDir, output, "output path");
  ensureParentDir(file);
  try {
    fs.writeFileSync(file, content);
  } catch (e) {
    throw new FlowBridgeError("PATH_BLOCKED", `Cannot write ${output}: ${(e as Error).message}`);
  }
  return file;
}

const FORMULA = /^[=+\-@\t\r]/;

export function runCsv(step: CsvStep, input: unknown, ctx: RuntimeContext): StepOutput {
  const rows = prepare(step, input);
  const cols = columns(rows, step.fields);
  const records = rows.map((r) =>
    cols.map((c) => {
      const cell = toCell(getPath(r, c.path));
      return step.sanitizeFormulas && typeof cell === "string" && FORMULA.test(cell) ? `'${cell}` : cell;
    }),
  );
  const csv = stringify([cols.map((c) => c.header), ...records], { delimiter: step.delimiter });
  const file = write(ctx, step.output, csv);
  return { data: rows, summary: `${rows.length} rows -> ${step.output}` };
}

export function runJson(step: JsonStep, input: unknown, ctx: RuntimeContext): StepOutput {
  const rows = prepare(step, input);
  let out: Row[] = rows;
  if (step.fields) {
    const cols = columns(rows, step.fields);
    out = rows.map((r) => Object.fromEntries(cols.map((c) => [c.header, getPath(r, c.path) ?? null])));
  }
  write(ctx, step.output, JSON.stringify(out, null, step.pretty ? 2 : undefined) + "\n");
  return { data: out, summary: `${out.length} records -> ${step.output}` };
}
