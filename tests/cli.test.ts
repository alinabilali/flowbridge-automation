import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { portOf, startMockServer } from "../scripts/mock-server.js";
import { tmpDir } from "./helpers.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const TSX = import.meta.resolve("tsx");
let server: Awaited<ReturnType<typeof startMockServer>>;
beforeAll(async () => { server = await startMockServer(0); });
afterAll(() => { server.close(); });

function cli(args: string[], cwd: string) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const p = spawn(process.execPath, ["--import", TSX, path.join(ROOT, "src/cli.ts"), ...args], { cwd, env: { ...process.env, NO_COLOR: "1" } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("exit", (code) => resolve({ code: code ?? -1, out }));
  });
}

function workflow(dir: string, url: string) {
  const file = path.join(dir, "wf.yaml");
  fs.writeFileSync(file, `name: e2e\nversion: 1\nsteps:\n  - id: users\n    type: http\n    url: ${url}\n  - id: export\n    type: csv\n    input: users\n    output: ./output/users.csv\n    fields: [name, email, company.name]\n`);
  return file;
}

describe("CLI end to end (offline)", () => {
  it("runs a workflow, writes CSV, exits 0, and records history", async () => {
    const dir = tmpDir();
    const wf = workflow(dir, `http://127.0.0.1:${portOf(server)}/users`);
    const r = await cli(["run", wf, "--allow-private-network"], dir);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Workflow succeeded");
    const csv = fs.readFileSync(path.join(dir, "output/users.csv"), "utf8").split("\n");
    expect(csv[0]).toBe("name,email,company.name");
    expect(csv).toHaveLength(7); // header + 5 rows + trailing newline
    const h = await cli(["history"], dir);
    expect(h.out).toMatch(/✓ #1 .* e2e/);
  });

  it("blocks local targets by default (exit 1) without the opt-in flag", async () => {
    const dir = tmpDir();
    const r = await cli(["run", workflow(dir, `http://127.0.0.1:${portOf(server)}/users`)], dir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/private or reserved address/);
    expect(fs.existsSync(path.join(dir, "output/users.csv"))).toBe(false);
  });

  it("exits 1 with a clear error when the API returns 404", async () => {
    const dir = tmpDir();
    const r = await cli(["run", workflow(dir, `http://127.0.0.1:${portOf(server)}/missing`), "--allow-private-network"], dir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/HTTP 404/);
  });

  it("exits 2 for invalid configuration, unreadable files and usage errors", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "bad.yaml"), "name: x\nversion: 1\nsteps:\n  - id: a\n    type: nope\n");
    const bad = await cli(["validate", path.join(dir, "bad.yaml")], dir);
    expect(bad.code).toBe(2);
    expect(bad.out).toMatch(/unknown or missing step type/);
    expect((await cli(["run", path.join(dir, "missing.yaml")], dir)).code).toBe(2);
    expect((await cli(["run"], dir)).code).toBe(2);
    expect((await cli(["--bogus"], dir)).code).toBe(2);
  });

  it("emits structured JSON logs and never prints the API token", async () => {
    const dir = tmpDir();
    const wf = workflow(dir, `http://127.0.0.1:${portOf(server)}/users`).replace("wf.yaml", "wf.yaml");
    fs.writeFileSync(wf, fs.readFileSync(wf, "utf8").replace("url:", "auth: { type: bearer, tokenEnv: API_TOKEN }\n    url:"));
    const r = await new Promise<string>((resolve) => {
      const p = spawn(process.execPath, ["--import", TSX, path.join(ROOT, "src/cli.ts"), "run", wf, "--allow-private-network", "--json-logs", "--verbose"], { cwd: dir, env: { ...process.env, API_TOKEN: "tok_cli_secret_42" } });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.on("exit", () => resolve(out));
    });
    const lines = r.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.every((l) => l.time && l.level && l.msg)).toBe(true);
    expect(r).not.toContain("tok_cli_secret_42");
  });
});
