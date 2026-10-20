import { z } from "zod";
import { FlowBridgeError } from "../lib/errors.js";
import { getPath, toRows, type Row } from "../lib/fields.js";
import type { StepOutput } from "../types.js";

export const joinSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, "id may only contain letters, digits, - and _"),
  type: z.literal("join"),
  continueOnError: z.boolean().optional(),
  /** Left-hand step id. */
  input: z.string().min(1),
  /** Right-hand step id. */
  with: z.string().min(1),
  on: z.strictObject({ left: z.string().min(1), right: z.string().min(1) }),
  kind: z.enum(["inner", "left"]).default("left"),
  /** Prefix for right-hand columns so they don't clobber left-hand ones. */
  rightPrefix: z.string().default("right_"),
});
export type JoinStep = z.infer<typeof joinSchema>;

export function runJoin(step: JoinStep, left: unknown, right: unknown): StepOutput {
  let l: Row[], r: Row[];
  try {
    l = toRows(left, `input "${step.input}"`);
    r = toRows(right, `input "${step.with}"`);
  } catch (e) {
    throw new FlowBridgeError("INPUT_INVALID", (e as Error).message);
  }
  const index = new Map<string, Row>();
  for (const row of r) {
    const k = getPath(row, step.on.right);
    if (k !== undefined && k !== null && !index.has(String(k))) index.set(String(k), row);
  }
  const out: Row[] = [];
  let unmatched = 0;
  for (const row of l) {
    const k = getPath(row, step.on.left);
    const match = k === undefined || k === null ? undefined : index.get(String(k));
    if (!match) {
      unmatched++;
      if (step.kind === "left") out.push({ ...row });
      continue;
    }
    const merged: Row = { ...row };
    for (const [key, v] of Object.entries(match)) merged[step.rightPrefix + key] = v;
    out.push(merged);
  }
  return { data: out, summary: `${l.length} left x ${r.length} right -> ${out.length} rows (${unmatched} unmatched)` };
}
