import { z } from "zod";
import { getPath, toRows, type Row } from "../lib/fields.js";
import { FlowBridgeError } from "../lib/errors.js";
import type { StepOutput } from "../types.js";

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const selectEntry = z.union([
  z.string().min(1),
  z.strictObject({
    from: z.string().min(1),
    default: scalar.optional(),
    required: z.boolean().optional(),
    /** Coerce the extracted value. */
    as: z.enum(["string", "number", "boolean"]).optional(),
  }),
]);

const condition = z.strictObject({
  field: z.string().min(1),
  op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "contains", "exists"]),
  value: scalar.optional(),
});

const baseId = z.string().regex(/^[A-Za-z0-9_-]+$/, "id may only contain letters, digits, - and _");

export const transformSchema = z.strictObject({
  id: baseId,
  type: z.literal("transform"),
  continueOnError: z.boolean().optional(),
  input: z.string().min(1),
  /** Optional path to the array inside the input (e.g. "data.items"). */
  path: z.string().optional(),
  where: z.array(condition).optional(),
  /** output column -> source path, or an object with default/required/as. */
  select: z.record(z.string().min(1), selectEntry).optional(),
  /** Records missing a `required` field: fail the step (default) or drop them. */
  onInvalid: z.enum(["error", "skip"]).default("error"),
  limit: z.number().int().positive().optional(),
});
export type TransformStep = z.infer<typeof transformSchema>;

function matches(row: Row, c: z.infer<typeof condition>): boolean {
  const v = getPath(row, c.field);
  switch (c.op) {
    case "exists": return v !== undefined && v !== null;
    case "eq": return v === c.value;
    case "ne": return v !== c.value;
    case "contains": return typeof v === "string" ? v.includes(String(c.value)) : Array.isArray(v) && v.includes(c.value);
    default: {
      if (typeof v !== "number" && typeof v !== "string") return false;
      const a = v as number, b = c.value as number;
      return c.op === "gt" ? a > b : c.op === "gte" ? a >= b : c.op === "lt" ? a < b : a <= b;
    }
  }
}

function coerce(v: unknown, as: "string" | "number" | "boolean"): unknown {
  if (v === null || v === undefined) return v;
  if (as === "string") return typeof v === "object" ? JSON.stringify(v) : String(v);
  if (as === "number") {
    const n = typeof v === "number" ? v : Number(v);
    if (typeof v === "object" || (typeof v === "string" && v.trim() === "") || Number.isNaN(n)) {
      throw new Error(`cannot convert ${JSON.stringify(v)} to number`);
    }
    return n;
  }
  if (typeof v === "boolean") return v;
  if (v === "true" || v === 1) return true;
  if (v === "false" || v === 0) return false;
  throw new Error(`cannot convert ${JSON.stringify(v)} to boolean`);
}

export function runTransform(step: TransformStep, input: unknown): StepOutput {
  const root = step.path ? getPath(input, step.path) : input;
  if (root === undefined) throw new FlowBridgeError("INPUT_INVALID", `path "${step.path}" not found in input "${step.input}"`);
  let rows: Row[];
  try {
    rows = toRows(root, `input "${step.input}"`);
  } catch (e) {
    throw new FlowBridgeError("INPUT_INVALID", (e as Error).message);
  }
  const total = rows.length;
  if (step.where) rows = rows.filter((r) => step.where!.every((c) => matches(r, c)));

  let skipped = 0;
  if (step.select) {
    const out: Row[] = [];
    rows.forEach((row, i) => {
      const rec: Row = {};
      try {
        for (const [col, spec] of Object.entries(step.select!)) {
          const cfg = typeof spec === "string" ? { from: spec } : spec;
          let v = getPath(row, cfg.from);
          if (v === undefined || v === null) {
            if ("default" in cfg && cfg.default !== undefined) v = cfg.default;
            else if ("required" in cfg && cfg.required) throw new Error(`missing required field "${cfg.from}"`);
            else v = null;
          }
          rec[col] = "as" in cfg && cfg.as ? coerce(v, cfg.as) : v;
        }
      } catch (e) {
        if (step.onInvalid === "skip") { skipped++; return; }
        throw new FlowBridgeError("DATA_INVALID", `record ${i}: ${(e as Error).message}`);
      }
      out.push(rec);
    });
    rows = out;
  }
  if (step.limit) rows = rows.slice(0, step.limit);
  const note = skipped ? `, ${skipped} skipped` : "";
  return { data: rows, summary: `${total} in -> ${rows.length} out${note}` };
}
