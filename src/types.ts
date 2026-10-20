import type { Logger } from "./lib/logger.js";

/** Everything a step may touch at runtime. Injected so tests can substitute pieces. */
export interface RuntimeContext {
  /** Outputs of completed steps, keyed by step id. */
  results: Map<string, unknown>;
  log: Logger;
  env: NodeJS.ProcessEnv;
  /** Directory that file outputs, databases, and file:// pages must stay inside. */
  rootDir: string;
  allowPrivateNetwork: boolean;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** DNS resolver override (tests). */
  lookup?: (host: string) => Promise<string[]>;
}

export interface StepOutput {
  /** Value made available to later steps via `input: <id>`. */
  data: unknown;
  /** One-line human summary, e.g. "42 rows -> output/users.csv". */
  summary: string;
}
