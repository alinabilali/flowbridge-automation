import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runWorkflow } from "../src/engine.js";
import { validateWorkflow } from "../src/config.js";
import { makeCtx } from "./helpers.js";

const FIXTURE = path.resolve(import.meta.dirname, "../fixtures/form.html");
const wf = (extra: object = {}, file = "fixtures/form.html") =>
  validateWorkflow({
    name: "b", version: 1,
    steps: [{ id: "form", type: "browser", file, timeoutMs: 3000, actions: [
      { action: "fill", selector: "#name", value: "Test User" },
      { action: "fill", selector: "#email", value: "t@example.com" },
      { action: "check", selector: "#terms" },
      { action: "click", selector: "#submit" },
      { action: "extract", selector: "#confirmation-message", name: "message" },
    ], ...extra }],
  });

function ctxWithFixture(env: NodeJS.ProcessEnv = process.env) {
  const ctx = makeCtx({ env });
  fs.mkdirSync(path.join(ctx.rootDir, "fixtures"));
  fs.copyFileSync(FIXTURE, path.join(ctx.rootDir, "fixtures/form.html"));
  return ctx;
}

describe("browser step", () => {
  it("blocks local files outside the root directory (no browser needed)", async () => {
    const r = await runWorkflow(wf({}, "/etc/hosts"), makeCtx());
    expect(r.steps[0]!.error?.code).toBe("PATH_BLOCKED");
  });

  it("reports a clear error when the browser binary is unavailable", async () => {
    const r = await runWorkflow(wf(), ctxWithFixture({ FLOWBRIDGE_BROWSER_EXECUTABLE: "/nonexistent/chromium" }));
    expect(r.steps[0]!.error).toMatchObject({ code: "BROWSER_UNAVAILABLE", message: expect.stringContaining("playwright install") });
  });

  it("blocks private network URLs by default", async () => {
    const w = validateWorkflow({ name: "b", version: 1, steps: [{ id: "p", type: "browser", url: "http://127.0.0.1:9/", actions: [{ action: "click", selector: "a" }] }] });
    const r = await runWorkflow(w, makeCtx({ allowPrivateNetwork: false }));
    expect(r.steps[0]!.error?.code).toBe("URL_BLOCKED");
  });
});

// Real-browser tests run only when Chromium can be launched here (see README: Browser automation).
async function browserAvailable(): Promise<boolean> {
  try {
    const pw = await import("playwright");
    const b = await pw.chromium.launch({ executablePath: process.env.FLOWBRIDGE_BROWSER_EXECUTABLE || undefined });
    await b.close();
    return true;
  } catch {
    return false;
  }
}
const available = await browserAvailable();

describe.skipIf(!available)("browser step (real Chromium)", () => {
  it("fills, submits and extracts the confirmation from the local fixture", async () => {
    const ctx = ctxWithFixture();
    const r = await runWorkflow(wf(), ctx);
    expect(r.status, JSON.stringify(r.steps)).toBe("success");
    expect(ctx.results.get("form")).toEqual({ message: "Thanks Test User, your free plan is active." });
  }, 30_000);

  it("fails with BROWSER_ERROR naming the failing action when a selector is missing", async () => {
    const r = await runWorkflow(wf({ actions: [{ action: "click", selector: "#does-not-exist" }] }), ctxWithFixture());
    expect(r.steps[0]!.error).toMatchObject({ code: "BROWSER_ERROR", message: expect.stringContaining("action #1 (click #does-not-exist)") });
  }, 30_000);
});
