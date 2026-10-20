import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateWorkflow } from "../src/config.js";
import { runWorkflow } from "../src/engine.js";
import { HistoryStore } from "../src/history.js";
import { json, makeCtx, serve, tmpDir } from "./helpers.js";

const wf = (steps: object[]) => validateWorkflow({ name: "t", version: 1, steps });

describe("workflow engine", () => {
  it("runs a multi-endpoint workflow end to end (join -> csv)", async () => {
    const s = await serve((req, res) =>
      json(res, req.url === "/users" ? [{ id: 1, name: "A" }, { id: 2, name: "B" }] : [{ userId: 1, title: "t1" }]),
    );
    const ctx = makeCtx();
    const r = await runWorkflow(
      wf([
        { id: "u", type: "http", url: `${s.base}/users` },
        { id: "p", type: "http", url: `${s.base}/posts` },
        { id: "j", type: "join", input: "u", with: "p", on: { left: "id", right: "userId" }, kind: "left", rightPrefix: "post_" },
        { id: "out", type: "csv", input: "j", output: "report.csv", fields: ["name", "post_title"] },
      ]),
      ctx,
    );
    expect(r.status).toBe("success");
    expect(fs.readFileSync(path.join(ctx.rootDir, "report.csv"), "utf8")).toBe("name,post_title\nA,t1\nB,\n");
    await s.close();
  });

  it("stops at the first failure, marks the rest skipped, and reports a useful error", async () => {
    const s = await serve((_q, res) => json(res, {}, 404));
    const r = await runWorkflow(
      wf([
        { id: "a", type: "http", url: `${s.base}/x` },
        { id: "b", type: "csv", input: "a", output: "o.csv" },
      ]),
      makeCtx(),
    );
    expect(r.status).toBe("failed");
    expect(r.steps.map((x) => x.status)).toEqual(["failed", "skipped"]);
    expect(r.steps[0]!.error).toMatchObject({ code: "HTTP_ERROR", message: expect.stringContaining("404") });
    await s.close();
  });

  it("continueOnError lets independent steps run but skips dependents", async () => {
    const s = await serve((req, res) => (req.url === "/bad" ? json(res, {}, 404) : json(res, [{ a: 1 }])));
    const ctx = makeCtx();
    const r = await runWorkflow(
      wf([
        { id: "bad", type: "http", url: `${s.base}/bad`, continueOnError: true },
        { id: "dep", type: "csv", input: "bad", output: "dep.csv" },
        { id: "good", type: "http", url: `${s.base}/good` },
        { id: "ok", type: "csv", input: "good", output: "ok.csv" },
      ]),
      ctx,
    );
    expect(r.steps.map((x) => x.status)).toEqual(["failed", "skipped", "success", "success"]);
    expect(r.status).toBe("failed");
    expect(fs.existsSync(path.join(ctx.rootDir, "ok.csv"))).toBe(true);
    await s.close();
  });

  it("surfaces missing environment variables without leaking values", async () => {
    const r = await runWorkflow(wf([{ id: "a", type: "http", url: "${BASE}/x" }]), makeCtx());
    expect(r.steps[0]!.error).toMatchObject({ code: "ENV_MISSING", message: "Environment variable BASE is not set" });
  });

  it("substitutes env variables and masks them in logs", async () => {
    const s = await serve((req, res) => json(res, { path: req.url }));
    const ctx = makeCtx({ env: { KEY: "sekret-value-9" } });
    const r = await runWorkflow(wf([{ id: "a", type: "http", url: `${s.base}/\${KEY}` }]), ctx);
    expect(r.status).toBe("success");
    expect(ctx.lines.join("\n")).not.toContain("sekret-value-9");
    await s.close();
  });

  it("converts unexpected exceptions into failed steps", async () => {
    const ctx = makeCtx({ fetch: (() => { throw new RangeError("boom"); }) as unknown as typeof fetch });
    const r = await runWorkflow(wf([{ id: "a", type: "http", url: "http://127.0.0.1:9/", retries: 0 }]), ctx);
    expect(r.status).toBe("failed");
  });
});

describe("history", () => {
  it("records runs and failed steps, redacting secrets", async () => {
    const ctx = makeCtx();
    ctx.log.addSecret("topsecret-123");
    const r = await runWorkflow(wf([{ id: "a", type: "http", url: "http://127.0.0.1:1/?token=topsecret-123", retries: 0 }]), ctx);
    const store = new HistoryStore(path.join(tmpDir(), "h.db"));
    store.record(r, ctx.log.redact);
    const [row] = store.recent();
    expect(row).toMatchObject({ workflow: "t", status: "failed", failed_step: "a" });
    expect(row!.error).not.toContain("topsecret-123");
    store.close();
  });
});
