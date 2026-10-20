import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunResult } from "./engine.js";

export interface HistoryRow {
  id: number;
  workflow: string;
  status: string;
  started_at: string;
  duration_ms: number;
  failed_step: string | null;
  error: string | null;
}

/** Execution history in a small SQLite file (default .flowbridge/history.db). */
export class HistoryStore {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file, { timeout: 5000 });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS step_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(id),
        step_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        summary TEXT,
        error_code TEXT,
        error_message TEXT
      );`);
  }

  /** Record a finished run. `redact` is applied to error text before it is stored. */
  record(r: RunResult, redact: (s: string) => string = (s) => s): number {
    this.db.exec("BEGIN");
    try {
      const run = this.db
        .prepare("INSERT INTO runs (workflow, status, started_at, duration_ms) VALUES (?, ?, ?, ?)")
        .run(r.workflow, r.status, r.startedAt, r.durationMs);
      const id = Number(run.lastInsertRowid);
      const ins = this.db.prepare(
        "INSERT INTO step_runs (run_id, step_id, type, status, duration_ms, summary, error_code, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const s of r.steps) {
        ins.run(id, s.id, s.type, s.status, s.durationMs, s.summary ? redact(s.summary) : null, s.error?.code ?? null, s.error ? redact(s.error.message) : null);
      }
      this.db.exec("COMMIT");
      return id;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  recent(limit = 10): HistoryRow[] {
    return this.db
      .prepare(
        `SELECT r.id, r.workflow, r.status, r.started_at, r.duration_ms,
                (SELECT step_id FROM step_runs s WHERE s.run_id = r.id AND s.status = 'failed' LIMIT 1) AS failed_step,
                (SELECT error_message FROM step_runs s WHERE s.run_id = r.id AND s.status = 'failed' LIMIT 1) AS error
         FROM runs r ORDER BY r.id DESC LIMIT ?`,
      )
      .all(limit) as unknown as HistoryRow[];
  }

  close(): void {
    this.db.close();
  }
}
