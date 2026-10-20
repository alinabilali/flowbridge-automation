import type { Step, Workflow } from "./config.js";
import { ConfigError, errorMessage, FlowBridgeError } from "./lib/errors.js";
import { interpolateEnv } from "./lib/env.js";
import type { Logger } from "./lib/logger.js";
import { runBrowser, type BrowserStep } from "./steps/browser.js";
import { runHttp, type HttpStep } from "./steps/http.js";
import { runJoin, type JoinStep } from "./steps/join.js";
import { runCsv, runJson, type CsvStep, type JsonStep } from "./steps/output.js";
import { runSqliteInsert, runSqliteQuery, type SqliteInsertStep, type SqliteQueryStep } from "./steps/sqlite.js";
import { runTransform, type TransformStep } from "./steps/transform.js";
import type { RuntimeContext, StepOutput } from "./types.js";

export type StepStatus = "success" | "failed" | "skipped";

export interface StepRecord {
  id: string;
  type: string;
  status: StepStatus;
  durationMs: number;
  summary?: string;
  error?: { code: string; message: string };
}

export interface RunResult {
  workflow: string;
  status: "success" | "failed";
  startedAt: string;
  durationMs: number;
  steps: StepRecord[];
  /** Outputs of successful steps (kept in memory only). */
  outputs: Map<string, unknown>;
}

async function dispatch(step: Step, ctx: RuntimeContext): Promise<StepOutput> {
  const input = "input" in step ? ctx.results.get(step.input) : undefined;
  switch (step.type) {
    case "http": return runHttp(step as HttpStep, ctx);
    case "transform": return runTransform(step as TransformStep, input);
    case "csv": return runCsv(step as CsvStep, input, ctx);
    case "json": return runJson(step as JsonStep, input, ctx);
    case "join": return runJoin(step as JoinStep, input, ctx.results.get((step as JoinStep).with));
    case "sqlite-insert": return runSqliteInsert(step as SqliteInsertStep, input, ctx);
    case "sqlite-query": return runSqliteQuery(step as SqliteQueryStep, ctx);
    case "browser": return runBrowser(step as BrowserStep, ctx);
  }
}

/**
 * Run steps sequentially. The first failure stops the workflow unless the step has
 * `continueOnError`, in which case only steps that depend on it are skipped.
 */
export async function runWorkflow(wf: Workflow, ctx: RuntimeContext): Promise<RunResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const records: StepRecord[] = [];
  const failed = new Set<string>();
  let aborted = false;

  for (const raw of wf.steps) {
    const type = raw.type;
    const deps = [("input" in raw ? raw.input : undefined), ("with" in raw ? raw.with : undefined)].filter(Boolean) as string[];
    const t0 = Date.now();

    if (aborted || deps.some((d) => failed.has(d))) {
      failed.add(raw.id);
      records.push({ id: raw.id, type, status: "skipped", durationMs: 0, summary: aborted ? "earlier step failed" : "dependency failed" });
      ctx.log.warn(`[${raw.id}] skipped`);
      continue;
    }

    try {
      // Secrets arrive via ${ENV} substitution; register them so they are masked in logs.
      const step = interpolateEnv(raw, ctx.env, (v) => ctx.log.addSecret(v));
      const out = await dispatch(step, ctx);
      ctx.results.set(raw.id, out.data);
      records.push({ id: raw.id, type, status: "success", durationMs: Date.now() - t0, summary: out.summary });
      ctx.log.info(`[${raw.id}] ${type}: ${out.summary}`, { ms: Date.now() - t0 });
    } catch (e) {
      const code = e instanceof FlowBridgeError ? e.code : "INTERNAL";
      const message = e instanceof FlowBridgeError || e instanceof ConfigError ? e.message : `Unexpected error: ${errorMessage(e)}`;
      records.push({ id: raw.id, type, status: "failed", durationMs: Date.now() - t0, error: { code, message } });
      ctx.log.error(`[${raw.id}] ${type} failed: ${message}`, { code });
      failed.add(raw.id);
      if (!raw.continueOnError) aborted = true;
    }
  }

  return {
    workflow: wf.name,
    status: records.some((r) => r.status === "failed") ? "failed" : "success",
    startedAt,
    durationMs: Date.now() - started,
    steps: records,
    outputs: ctx.results,
  };
}

export type { Logger };
