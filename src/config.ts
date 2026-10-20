import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ConfigError } from "./lib/errors.js";
import { browserSchema } from "./steps/browser.js";
import { httpSchema } from "./steps/http.js";
import { joinSchema } from "./steps/join.js";
import { csvSchema, jsonSchema } from "./steps/output.js";
import { sqliteInsertSchema, sqliteQuerySchema } from "./steps/sqlite.js";
import { transformSchema } from "./steps/transform.js";

/** Registry of step types. Adding a step = add its schema here and a case in engine.ts. */
export const stepSchemas = {
  http: httpSchema,
  transform: transformSchema,
  csv: csvSchema,
  json: jsonSchema,
  join: joinSchema,
  "sqlite-insert": sqliteInsertSchema,
  "sqlite-query": sqliteQuerySchema,
  browser: browserSchema,
} as const;

export type Step =
  | z.infer<typeof httpSchema>
  | z.infer<typeof transformSchema>
  | z.infer<typeof csvSchema>
  | z.infer<typeof jsonSchema>
  | z.infer<typeof joinSchema>
  | z.infer<typeof sqliteInsertSchema>
  | z.infer<typeof sqliteQuerySchema>
  | z.infer<typeof browserSchema>;

export interface Workflow {
  name: string;
  version: 1;
  description?: string;
  steps: Step[];
}

const envelope = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/, "must be 1-80 characters: letters, digits, space, . _ -"),
  version: z.literal(1, { error: "must be 1" }),
  description: z.string().optional(),
  steps: z.array(z.unknown()).min(1, "a workflow needs at least one step"),
});

const issue = (loc: (string | number | symbol)[], msg: string) => `  - ${loc.join(".") || "(root)"}: ${msg}`;

export function validateWorkflow(raw: unknown, label = "workflow"): Workflow {
  const problems: string[] = [];
  const head = envelope.safeParse(raw);
  if (!head.success) {
    throw new ConfigError(`${label} is invalid:\n${head.error.issues.map((i) => issue(i.path, i.message)).join("\n")}`);
  }

  const steps: Step[] = [];
  const seen = new Set<string>();
  head.data.steps.forEach((rawStep, i) => {
    const type = (rawStep as { type?: unknown } | null)?.type;
    if (typeof type !== "string" || !(type in stepSchemas)) {
      problems.push(issue(["steps", i, "type"], `unknown or missing step type ${JSON.stringify(type)}; expected one of: ${Object.keys(stepSchemas).join(", ")}`));
      return;
    }
    const parsed = stepSchemas[type as keyof typeof stepSchemas].safeParse(rawStep);
    if (!parsed.success) {
      parsed.error.issues.forEach((it) => problems.push(issue(["steps", i, ...it.path], it.message)));
      return;
    }
    const step = parsed.data as Step;
    if (seen.has(step.id)) problems.push(issue(["steps", i, "id"], `duplicate step id "${step.id}"`));
    const refs = [("input" in step ? step.input : undefined), ("with" in step ? step.with : undefined)].filter(Boolean) as string[];
    for (const ref of refs) {
      if (!seen.has(ref)) problems.push(issue(["steps", i], `step "${step.id}" references "${ref}", which is not defined earlier in the workflow`));
    }
    seen.add(step.id);
    steps.push(step);
  });

  if (problems.length) throw new ConfigError(`${label} is invalid:\n${problems.join("\n")}`);
  return { name: head.data.name, version: 1, description: head.data.description, steps };
}

/** Parse + validate workflow text. */
export function parseWorkflow(text: string, format: "yaml" | "json", label = "workflow"): Workflow {
  let raw: unknown;
  try {
    raw = format === "json" ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    throw new ConfigError(`${label}: cannot parse ${format.toUpperCase()}: ${(e as Error).message.split("\n")[0]}`);
  }
  return validateWorkflow(raw, label);
}

export function loadWorkflow(file: string): Workflow {
  const ext = path.extname(file).toLowerCase();
  if (![".yaml", ".yml", ".json"].includes(ext)) {
    throw new ConfigError(`Unsupported workflow file type "${ext}" (use .yaml, .yml or .json)`);
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new ConfigError(`Cannot read workflow file ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  return parseWorkflow(text, ext === ".json" ? "json" : "yaml", path.basename(file));
}
