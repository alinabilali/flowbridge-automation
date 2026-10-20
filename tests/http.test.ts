import { describe, expect, it } from "vitest";
import { isPrivateAddress } from "../src/lib/url-policy.js";
import { httpSchema, runHttp } from "../src/steps/http.js";
import { json, makeCtx, serve } from "./helpers.js";

const step = (o: object) => httpSchema.parse({ id: "h", type: "http", url: "http://x", ...o });

describe("http step", () => {
  it("fetches and parses JSON, honouring headers, query and dataPath", async () => {
    const s = await serve((req, res) => json(res, { echo: req.url, ua: req.headers["x-custom"], items: [{ a: 1 }] }));
    const out = await runHttp(step({ url: `${s.base}/data`, query: { page: 2 }, headers: { "x-custom": "yes" }, dataPath: "items" }), makeCtx());
    expect(out.data).toEqual([{ a: 1 }]);
    const whole = await runHttp(step({ url: `${s.base}/data`, query: { page: 2 }, headers: { "x-custom": "yes" } }), makeCtx());
    expect(whole.data).toMatchObject({ echo: "/data?page=2", ua: "yes" });
    await s.close();
  });

  it("fails clearly on a missing dataPath and on malformed JSON", async () => {
    const s = await serve((req, res) => (req.url === "/bad" ? (res.writeHead(200), res.end("<html>")) : json(res, { a: 1 })));
    await expect(runHttp(step({ url: `${s.base}/ok`, dataPath: "nope" }), makeCtx())).rejects.toThrow(/dataPath "nope" not found/);
    await expect(runHttp(step({ url: `${s.base}/bad` }), makeCtx())).rejects.toMatchObject({ code: "RESPONSE_INVALID" });
    await s.close();
  });

  it("does not retry a 404", async () => {
    const s = await serve((_q, res) => json(res, { error: "nope" }, 404));
    await expect(runHttp(step({ url: `${s.base}/a` }), makeCtx())).rejects.toMatchObject({ code: "HTTP_ERROR", message: expect.stringContaining("404") });
    expect(s.hits.get("/a")).toBe(1);
    await s.close();
  });

  it("retries 503 with backoff and then succeeds", async () => {
    const sleeps: number[] = [];
    const s = await serve((_q, res, n) => (n < 3 ? json(res, {}, 503) : json(res, { ok: true })));
    const out = await runHttp(step({ url: `${s.base}/flaky` }), makeCtx({ sleep: async (ms) => void sleeps.push(ms) }));
    expect(out.data).toEqual({ ok: true });
    expect(s.hits.get("/flaky")).toBe(3);
    expect(sleeps).toHaveLength(2);
    await s.close();
  });

  it("gives up after the configured retries with a useful error", async () => {
    const s = await serve((_q, res) => json(res, {}, 500));
    await expect(runHttp(step({ url: `${s.base}/down`, retries: 1 }), makeCtx())).rejects.toThrow(/HTTP 500.*after 2 attempts/);
    expect(s.hits.get("/down")).toBe(2);
    await s.close();
  });

  it("never retries POST", async () => {
    const s = await serve((_q, res) => json(res, {}, 503));
    await expect(runHttp(step({ method: "POST", url: `${s.base}/p`, body: { a: 1 } }), makeCtx())).rejects.toThrow(/503/);
    expect(s.hits.get("/p")).toBe(1);
    await s.close();
  });

  it("times out", async () => {
    const s = await serve(() => {
      /* never respond */
    });
    const p = runHttp(step({ url: `${s.base}/slow`, timeoutMs: 150, retries: 0 }), makeCtx());
    await expect(p).rejects.toMatchObject({ code: "HTTP_TIMEOUT" });
    await s.close();
  }, 10_000);

  it("reports network failures", async () => {
    await expect(runHttp(step({ url: "http://127.0.0.1:1/", retries: 0 }), makeCtx())).rejects.toMatchObject({ code: "HTTP_NETWORK" });
  });

  it("enforces the response size limit", async () => {
    const s = await serve((_q, res) => json(res, { big: "x".repeat(5000) }));
    await expect(runHttp(step({ url: `${s.base}/big`, maxResponseBytes: 1000 }), makeCtx())).rejects.toThrow(/too large|exceeded/);
    await s.close();
  });

  it("sends bearer auth from the environment and never logs the token", async () => {
    const token = "tok_super_secret_123";
    const s = await serve((req, res) => json(res, { auth: req.headers.authorization }));
    const ctx = makeCtx({ env: { API_TOKEN: token } });
    const out = await runHttp(step({ url: `${s.base}/me?token=${token}`, auth: { type: "bearer", tokenEnv: "API_TOKEN" } }), ctx);
    expect(out.data).toEqual({ auth: `Bearer ${token}` });
    expect(ctx.lines.join("\n")).not.toContain(token);
    expect(ctx.log.redact(`oops ${token}`)).toBe("oops ***");
    await s.close();
  });

  it("fails fast when an auth env var is missing, naming only the variable", async () => {
    await expect(runHttp(step({ url: "http://x", auth: { type: "bearer", tokenEnv: "NOPE_TOKEN" } }), makeCtx())).rejects.toMatchObject({ code: "ENV_MISSING", message: expect.stringContaining("NOPE_TOKEN") });
  });

  it("drops the Authorization header when a redirect crosses origins", async () => {
    const target = await serve((req, res) => json(res, { auth: req.headers.authorization ?? null }));
    const origin = await serve((_q, res) => {
      res.writeHead(302, { location: `${target.base}/landing` });
      res.end();
    });
    const out = await runHttp(step({ url: `${origin.base}/r`, auth: { type: "bearer", tokenEnv: "T" } }), makeCtx({ env: { T: "tok_abcdef" } }));
    expect(out.data).toEqual({ auth: null });
    await origin.close();
    await target.close();
  });
});

describe("SSRF protection", () => {
  const blocked = (url: string, lookup?: (h: string) => Promise<string[]>) =>
    runHttp(step({ url }), makeCtx({ allowPrivateNetwork: false, lookup }));

  it.each([
    "http://127.0.0.1/", "http://localhost:3000/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/", "http://192.168.1.1/", "http://[::ffff:127.0.0.1]/",
  ])("blocks %s", async (url) => {
    await expect(blocked(url, async (h) => (h === "localhost" ? ["127.0.0.1"] : []))).rejects.toMatchObject({ code: "URL_BLOCKED" });
  });

  it("blocks hostnames that resolve to private addresses", async () => {
    await expect(blocked("http://internal.example.com/", async () => ["10.1.2.3"])).rejects.toMatchObject({ code: "URL_BLOCKED" });
  });

  it("blocks non-http protocols and embedded credentials", async () => {
    await expect(blocked("file:///etc/passwd")).rejects.toThrow(/Protocol file:/);
    await expect(blocked("ftp://example.com/x")).rejects.toThrow(/not allowed/);
    await expect(blocked("https://user:pw@example.com/")).rejects.toThrow(/credentials/);
  });

  it("blocks a redirect from a public host to a private one", async () => {
    const internal = await serve((_q, res) => json(res, { secret: true }));
    const pub = await serve((_q, res) => {
      res.writeHead(302, { location: `${internal.base}/admin` });
      res.end();
    });
    // The first hop is "public" via stubbed DNS; the redirect target is a literal loopback IP.
    const ctx = makeCtx({ allowPrivateNetwork: false, lookup: async () => ["93.184.216.34"] });
    const url = pub.base.replace("127.0.0.1", "public.example.com");
    // Route the public hostname to the local server for the actual connection.
    const realFetch = globalThis.fetch;
    ctx.fetch = ((u: URL, init: RequestInit) => realFetch(String(u).replace("public.example.com", "127.0.0.1"), init)) as typeof fetch;
    await expect(runHttp(step({ url: `${url}/start`, retries: 0 }), ctx)).rejects.toMatchObject({ code: "URL_BLOCKED" });
    expect(internal.hits.get("/admin")).toBeUndefined();
    await pub.close();
    await internal.close();
  });

  it("classifies addresses", () => {
    for (const ip of ["0.0.0.0", "100.64.0.1", "172.16.0.1", "172.31.255.1", "fd00::1", "fe80::1", "::", "::1", "::ffff:7f00:1", "64:ff9b::7f00:1", "::127.0.0.1", "ff02::1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111", "::ffff:808:808", "64:ff9b::808:808"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});
