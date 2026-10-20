import { z } from "zod";
import { FlowBridgeError } from "../lib/errors.js";
import { getPath } from "../lib/fields.js";
import { redactUrl } from "../lib/logger.js";
import { assertUrlAllowed } from "../lib/url-policy.js";
import type { RuntimeContext, StepOutput } from "../types.js";

const auth = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("bearer"), tokenEnv: z.string().min(1) }),
  z.strictObject({ type: z.literal("basic"), usernameEnv: z.string().min(1), passwordEnv: z.string().min(1) }),
  z.strictObject({ type: z.literal("header"), header: z.string().min(1), valueEnv: z.string().min(1) }),
]);

export const httpSchema = z
  .strictObject({
    id: z.string().regex(/^[A-Za-z0-9_-]+$/, "id may only contain letters, digits, - and _"),
    type: z.literal("http"),
    continueOnError: z.boolean().optional(),
    method: z.enum(["GET", "POST"]).default("GET"),
    url: z.string().min(1),
    query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    auth: auth.optional(),
    /** Dotted path into the JSON response to use as the step output. */
    dataPath: z.string().optional(),
    timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
    /** Extra attempts after the first (GET only). Defaults to 2. */
    retries: z.number().int().min(0).max(5).optional(),
    maxResponseBytes: z.number().int().positive().max(100 * 1024 * 1024).default(10 * 1024 * 1024),
  })
  .refine((s) => s.method === "GET" || !s.retries, {
    message: "retries are only allowed for GET requests (non-idempotent requests are never retried)",
    path: ["retries"],
  });
export type HttpStep = z.infer<typeof httpSchema>;

const FORBIDDEN_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding"]);
const MAX_REDIRECTS = 5;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function buildHeaders(step: HttpStep, ctx: RuntimeContext): Headers {
  const h = new Headers({ accept: "application/json", "user-agent": "flowbridge/0.1" });
  for (const [k, v] of Object.entries(step.headers ?? {})) {
    if (FORBIDDEN_HEADERS.has(k.toLowerCase())) throw new FlowBridgeError("CONFIG_INVALID", `Header ${k} may not be set`);
    h.set(k, v);
    if (/^(authorization|x-api-key|cookie|proxy-authorization)$/i.test(k)) ctx.log.addSecret(v);
  }
  const need = (name: string): string => {
    const v = ctx.env[name];
    if (!v) throw new FlowBridgeError("ENV_MISSING", `Environment variable ${name} is not set`);
    ctx.log.addSecret(v);
    return v;
  };
  const a = step.auth;
  if (a?.type === "bearer") h.set("authorization", `Bearer ${need(a.tokenEnv)}`);
  if (a?.type === "basic") {
    const raw = `${need(a.usernameEnv)}:${need(a.passwordEnv)}`;
    const enc = Buffer.from(raw).toString("base64");
    ctx.log.addSecret(enc);
    h.set("authorization", `Basic ${enc}`);
  }
  if (a?.type === "header") h.set(a.header, need(a.valueEnv));
  if (step.body !== undefined) h.set("content-type", "application/json");
  return h;
}

async function readBody(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > max) throw new FlowBridgeError("RESPONSE_INVALID", `Response too large (${declared} bytes > ${max})`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new FlowBridgeError("RESPONSE_INVALID", `Response exceeded ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One attempt, following redirects manually so every hop is re-validated. */
async function attempt(step: HttpStep, ctx: RuntimeContext, startUrl: URL, headers: Headers): Promise<Response> {
  let url = startUrl;
  let method: string = step.method;
  let body = step.body !== undefined ? JSON.stringify(step.body) : undefined;
  const signal = AbortSignal.timeout(step.timeoutMs);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await ctx.fetch(url, { method, headers, body, redirect: "manual", signal });
    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      await res.body?.cancel();
      const next = new URL(res.headers.get("location")!, url);
      await assertUrlAllowed(next.toString(), policy(ctx));
      if (next.origin !== url.origin) {
        headers = new Headers(headers);
        headers.delete("authorization");
        headers.delete("cookie");
        for (const k of Object.keys(step.headers ?? {})) headers.delete(k);
        if (step.auth?.type === "header") headers.delete(step.auth.header);
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        headers.delete("content-type");
      }
      url = next;
      continue;
    }
    return res;
  }
  throw new FlowBridgeError("HTTP_ERROR", `Too many redirects (>${MAX_REDIRECTS})`);
}

const policy = (ctx: RuntimeContext) => ({ allowPrivateNetwork: ctx.allowPrivateNetwork, lookup: ctx.lookup });

export async function runHttp(step: HttpStep, ctx: RuntimeContext): Promise<StepOutput> {
  const url = await assertUrlAllowed(step.url, policy(ctx));
  for (const [k, v] of Object.entries(step.query ?? {})) url.searchParams.set(k, String(v));
  const headers = buildHeaders(step, ctx);
  const maxAttempts = step.method === "GET" ? (step.retries ?? 2) + 1 : 1;
  let lastError: FlowBridgeError | undefined;

  for (let n = 1; n <= maxAttempts; n++) {
    let retryAfterMs: number | undefined;
    try {
      ctx.log.debug(`${step.method} ${redactUrl(url.toString())}`, { attempt: n });
      const res = await attempt(step, ctx, url, headers);
      if (!res.ok) {
        retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
        await res.body?.cancel();
        const err = new FlowBridgeError("HTTP_ERROR", `HTTP ${res.status} ${res.statusText} from ${redactUrl(url.toString())}`);
        if (!RETRYABLE_STATUS.has(res.status)) throw err;
        lastError = err;
      } else {
        const text = await readBody(res, step.maxResponseBytes);
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new FlowBridgeError("RESPONSE_INVALID", `Response from ${redactUrl(url.toString())} is not valid JSON`);
        }
        const data = step.dataPath ? getPath(json, step.dataPath) : json;
        if (data === undefined) {
          throw new FlowBridgeError("RESPONSE_INVALID", `dataPath "${step.dataPath}" not found in response`);
        }
        const count = Array.isArray(data) ? `${data.length} records` : "1 object";
        return { data, summary: `${step.method} ${redactUrl(url.toString())} -> ${res.status}, ${count}` };
      }
    } catch (e) {
      if (e instanceof FlowBridgeError && e.code !== "HTTP_NETWORK" && e.code !== "HTTP_TIMEOUT") throw e;
      if (e instanceof FlowBridgeError) lastError = e;
      else if ((e as Error).name === "TimeoutError" || (e as Error).name === "AbortError") {
        lastError = new FlowBridgeError("HTTP_TIMEOUT", `Request timed out after ${step.timeoutMs}ms`, { cause: e });
      } else {
        lastError = new FlowBridgeError("HTTP_NETWORK", `Network error: ${(e as Error).message}`, { cause: e });
      }
    }
    if (n < maxAttempts) {
      const backoff = Math.min(250 * 2 ** (n - 1), 5_000) * (0.5 + Math.random() / 2);
      const wait = Math.min(retryAfterMs ?? backoff, 30_000);
      ctx.log.warn(`${lastError!.message}; retrying`, { attempt: n, of: maxAttempts, waitMs: Math.round(wait) });
      await ctx.sleep(wait);
    }
  }
  throw new FlowBridgeError(lastError!.code, `${lastError!.message} (after ${maxAttempts} attempt${maxAttempts > 1 ? "s" : ""})`, {
    cause: lastError,
  });
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s)) return s * 1000;
  const d = Date.parse(v);
  return Number.isNaN(d) ? undefined : Math.max(0, d - Date.now());
}
