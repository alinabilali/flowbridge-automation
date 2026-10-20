#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadWorkflow } from "./config.js";
import { runWorkflow } from "./engine.js";
import { HistoryStore } from "./history.js";
import { ConfigError, errorMessage } from "./lib/errors.js";
import { createLogger, type LogLevel } from "./lib/logger.js";
import type { RuntimeContext } from "./types.js";

const HELP = `FlowBridge - configurable automation toolkit

Usage:
  flowbridge run <workflow.yaml>       Validate and execute a workflow
  flowbridge validate <workflow.yaml>  Validate a workflow without running it
  flowbridge history                   Show recent runs

Options:
  --root <dir>              Directory outputs/databases must stay inside (default: current directory)
  --allow-private-network   Permit http steps to reach localhost/private addresses (off by default)
  --json-logs               Emit structured JSON log lines
  --verbose                 Include debug logs
  --history-db <file>       Run history database (default: .flowbridge/history.db)
  --no-history              Do not record this run
  --limit <n>               Rows for "history" (default: 10)
  -h, --help                Show this help

Exit codes: 0 success, 1 workflow failed, 2 invalid usage or configuration`;

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        root: { type: "string" },
        "allow-private-network": { type: "boolean" },
        "json-logs": { type: "boolean" },
        verbose: { type: "boolean" },
        "history-db": { type: "string" },
        "no-history": { type: "boolean" },
        limit: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    console.error(`Error: ${errorMessage(e)}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, file] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return command || values.help ? 0 : 2;
  }

  const log = createLogger({
    level: (values.verbose ? "debug" : "info") satisfies LogLevel,
    json: values["json-logs"],
    color: process.stdout.isTTY && !process.env.NO_COLOR,
  });
  const historyFile = values["history-db"] ?? ".flowbridge/history.db";

  try {
    if (command === "history") {
      const store = new HistoryStore(historyFile);
      const rows = store.recent(Number(values.limit ?? 10) || 10);
      store.close();
      if (!rows.length) console.log("No runs recorded yet.");
      for (const r of rows) {
        const icon = r.status === "success" ? "✓" : "✗";
        console.log(`${icon} #${r.id} ${r.started_at} ${r.workflow} (${r.duration_ms}ms)${r.error ? ` - ${r.failed_step}: ${r.error}` : ""}`);
      }
      return 0;
    }

    if (command !== "run" && command !== "validate") {
      console.error(`Unknown command "${command}"\n\n${HELP}`);
      return 2;
    }
    if (!file) {
      console.error(`Missing workflow file\n\n${HELP}`);
      return 2;
    }

    const wf = loadWorkflow(file);
    if (command === "validate") {
      log.info(`${wf.name}: valid (${wf.steps.length} steps)`);
      return 0;
    }

    if (fs.existsSync(".env")) process.loadEnvFile(".env"); // does not override real env vars

    const rootDir = path.resolve(values.root ?? process.cwd());
    if (!fs.existsSync(rootDir)) throw new ConfigError(`--root directory ${rootDir} does not exist`);

    const ctx: RuntimeContext = {
      results: new Map(),
      log,
      env: process.env,
      rootDir,
      allowPrivateNetwork: Boolean(values["allow-private-network"]),
      fetch: globalThis.fetch,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };

    log.info(`Running "${wf.name}" (${wf.steps.length} steps)`);
    const result = await runWorkflow(wf, ctx);

    if (!values["no-history"]) {
      try {
        const store = new HistoryStore(historyFile);
        const id = store.record(result, log.redact);
        store.close();
        log.debug(`recorded run #${id}`);
      } catch (e) {
        log.warn(`could not write run history: ${errorMessage(e)}`);
      }
    }

    const ok = result.steps.filter((s) => s.status === "success").length;
    if (result.status === "success") {
      log.info(`Workflow succeeded: ${ok}/${result.steps.length} steps in ${result.durationMs}ms`);
      return 0;
    }
    log.error(`Workflow failed: ${ok}/${result.steps.length} steps succeeded`);
    return 1;
  } catch (e) {
    if (e instanceof ConfigError) {
      log.error(e.message);
      return 2;
    }
    log.error(`Unexpected error: ${errorMessage(e)}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
