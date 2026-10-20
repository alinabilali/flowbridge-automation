import fs from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { FlowBridgeError } from "../lib/errors.js";
import { getPath, toRows, type Row } from "../lib/fields.js";
import { ensureParentDir, resolveInside } from "../lib/safe-path.js";
import type { RuntimeContext, StepOutput } from "../types.js";

const baseId = z.string().regex(/^[A-Za-z0-9_-]+$/, "id may only contain letters, digits, - and _");
const ident = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, "must be a plain SQL identifier (letters, digits, _)");

export const sqliteInsertSchema = z.strictObject({
  id: baseId,
  type: z.literal("sqlite-insert"),
  continueOnError: z.boolean().optional(),
  input: z.string().min(1),
  database: z.string().min(1),
  table: ident,
  /** column name -> where to read it and how to store it. */
  columns: z
    .record(
      ident,
      z.strictObject({
        from: z.string().min(1).optional(),
        type: z.enum(["TEXT", "INTEGER", "REAL"]).default("TEXT"),
        required: z.boolean().optional(),
        primaryKey: z.boolean().optional(),
      }),
    )
    .refine((c) => Object.keys(c).length > 0, "at least one column is required"),
  onConflict: z.enum(["fail", "ignore", "replace"]).default("fail"),
  onInvalid: z.enum(["error", "skip"]).default("error"),
});
export type SqliteInsertStep = z.infer<typeof sqliteInsertSchema>;

export const sqliteQuerySchema = z.strictObject({
  id: baseId,
  type: z.literal("sqlite-query"),
  continueOnError: z.boolean().optional(),
  database: z.string().min(1),
  /** A single read-only SELECT/WITH statement. Use ? placeholders with `params`. */
  sql: z.string().min(1),
  params: z.array(z.union([z.string(), z.number(), z.null()])).default([]),
});
export type SqliteQueryStep = z.infer<typeof sqliteQuerySchema>;

function dbError(e: unknown, what: string): FlowBridgeError {
  if (e instanceof FlowBridgeError) return e;
  return new FlowBridgeError("DB_ERROR", `${what}: ${(e as Error).message}`, { cause: e });
}

function coerceValue(v: unknown, type: "TEXT" | "INTEGER" | "REAL", col: string): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (type === "TEXT") return typeof v === "object" ? JSON.stringify(v) : String(v);
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n) || (type === "INTEGER" && !Number.isInteger(n))) {
    throw new Error(`column ${col}: ${JSON.stringify(v)} is not a valid ${type}`);
  }
  return n;
}

export function runSqliteInsert(step: SqliteInsertStep, input: unknown, ctx: RuntimeContext): StepOutput {
  let rows: Row[];
  try {
    rows = toRows(input, `input "${step.input}"`);
  } catch (e) {
    throw new FlowBridgeError("INPUT_INVALID", (e as Error).message);
  }
  const file = resolveInside(ctx.rootDir, step.database, "database path");
  ensureParentDir(file);

  const cols = Object.entries(step.columns);
  const defs = cols.map(([name, c]) => `${name} ${c.type}${c.primaryKey ? " PRIMARY KEY" : ""}${c.required ? " NOT NULL" : ""}`);
  const verb = { fail: "INSERT", ignore: "INSERT OR IGNORE", replace: "INSERT OR REPLACE" }[step.onConflict];

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { timeout: 5000 });
    db.exec(`CREATE TABLE IF NOT EXISTS ${step.table} (${defs.join(", ")})`);
    const stmt = db.prepare(
      `${verb} INTO ${step.table} (${cols.map(([n]) => n).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    );

    // Validate everything first so a bad record never leaves a half-written batch.
    const valid: SQLInputValue[][] = [];
    let rejected = 0;
    rows.forEach((row, i) => {
      try {
        valid.push(
          cols.map(([name, c]) => {
            const raw = getPath(row, c.from ?? name);
            if ((raw === undefined || raw === null) && (c.required || c.primaryKey)) {
              throw new Error(`column ${name}: missing required value (from "${c.from ?? name}")`);
            }
            return coerceValue(raw, c.type, name);
          }),
        );
      } catch (e) {
        if (step.onInvalid === "skip") {
          rejected++;
          ctx.log.warn(`skipping record ${i}: ${(e as Error).message}`);
        } else {
          throw new FlowBridgeError("DATA_INVALID", `record ${i}: ${(e as Error).message}`);
        }
      }
    });

    let changed = 0;
    db.exec("BEGIN");
    try {
      for (const params of valid) changed += Number(stmt.run(...params).changes);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    const ignored = valid.length - changed;
    return {
      data: { table: step.table, inserted: changed, ignored, rejected },
      summary: `${changed} rows written to ${step.table}` + (ignored ? `, ${ignored} duplicates` : "") + (rejected ? `, ${rejected} rejected` : ""),
    };
  } catch (e) {
    throw dbError(e, `SQLite insert into ${step.table} failed`);
  } finally {
    db?.close();
  }
}

export function runSqliteQuery(step: SqliteQueryStep, ctx: RuntimeContext): StepOutput {
  if (!/^\s*(select|with)\b/i.test(step.sql)) {
    throw new FlowBridgeError("CONFIG_INVALID", "sqlite-query only accepts SELECT or WITH statements");
  }
  const file = resolveInside(ctx.rootDir, step.database, "database path");
  if (!fs.existsSync(file)) throw new FlowBridgeError("DB_ERROR", `Database ${step.database} does not exist`);
  let db: DatabaseSync | undefined;
  try {
    // Read-only connection: even a crafted statement cannot modify data.
    db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
    const rows = db.prepare(step.sql).all(...step.params) as Row[];
    const plain = rows.map((r) => ({ ...r }));
    return { data: plain, summary: `${plain.length} rows` };
  } catch (e) {
    throw dbError(e, "SQLite query failed");
  } finally {
    db?.close();
  }
}
