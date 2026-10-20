import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createLogger, type Logger } from "../src/lib/logger.js";
import type { RuntimeContext } from "../src/types.js";

export function tmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flowbridge-")));
}

export function makeCtx(overrides: Partial<RuntimeContext> = {}): RuntimeContext & { lines: string[] } {
  const lines: string[] = [];
  const log: Logger = createLogger({ level: "debug", write: (l) => lines.push(l) });
  return {
    results: new Map(),
    log,
    env: {},
    rootDir: tmpDir(),
    allowPrivateNetwork: true,
    fetch: globalThis.fetch,
    sleep: async () => {},
    ...overrides,
    lines,
  };
}

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse, hits: number) => void;

/** Start a throwaway local HTTP server; `hits` counts requests to each path. */
export async function serve(handler: Handler) {
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const key = req.url ?? "/";
    hits.set(key, (hits.get(key) ?? 0) + 1);
    handler(req, res, hits.get(key)!);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export const json = (res: http.ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
