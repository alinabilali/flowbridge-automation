import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures");

/** Tiny deterministic API serving fixtures/users.json and fixtures/posts.json. */
export function startMockServer(port = 0): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const name = req.url?.split("?")[0]?.replace(/^\//, "");
    if ((name === "users" || name === "posts") && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(fs.readFileSync(path.join(FIXTURES, `${name}.json`)));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

export const portOf = (s: http.Server) => (s.address() as AddressInfo).port;
