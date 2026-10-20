import { pathToFileURL } from "node:url";
import { z } from "zod";
import { FlowBridgeError } from "../lib/errors.js";
import { resolveInside } from "../lib/safe-path.js";
import { assertUrlAllowed } from "../lib/url-policy.js";
import type { RuntimeContext, StepOutput } from "../types.js";

const sel = z.string().min(1);
const action = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("fill"), selector: sel, value: z.string() }),
  z.strictObject({ action: z.literal("select"), selector: sel, value: z.string() }),
  z.strictObject({ action: z.literal("check"), selector: sel }),
  z.strictObject({ action: z.literal("click"), selector: sel }),
  z.strictObject({ action: z.literal("waitFor"), selector: sel }),
  z.strictObject({ action: z.literal("extract"), selector: sel, name: z.string().min(1), attribute: z.string().optional() }),
]);

export const browserSchema = z
  .strictObject({
    id: z.string().regex(/^[A-Za-z0-9_-]+$/, "id may only contain letters, digits, - and _"),
    type: z.literal("browser"),
    continueOnError: z.boolean().optional(),
    /** http(s) page to open. Subject to the same URL policy as the http step. */
    url: z.string().min(1).optional(),
    /** Local HTML file (must be inside the root directory). Use instead of `url`. */
    file: z.string().min(1).optional(),
    actions: z.array(action).min(1),
    headless: z.boolean().default(true),
    timeoutMs: z.number().int().min(500).max(120_000).default(15_000),
  })
  .refine((s) => Boolean(s.url) !== Boolean(s.file), { message: "provide exactly one of `url` or `file`", path: ["url"] });
export type BrowserStep = z.infer<typeof browserSchema>;

export async function runBrowser(step: BrowserStep, ctx: RuntimeContext): Promise<StepOutput> {
  let start: string;
  if (step.file) start = pathToFileURL(resolveInside(ctx.rootDir, step.file, "browser file")).toString();
  else start = (await assertUrlAllowed(step.url!, { allowPrivateNetwork: ctx.allowPrivateNetwork, lookup: ctx.lookup })).toString();
  const startUrl = new URL(start);

  let pw: typeof import("playwright");
  try {
    pw = await import("playwright");
  } catch {
    throw new FlowBridgeError(
      "BROWSER_UNAVAILABLE",
      "Playwright is not installed. Run: npm install playwright && npx playwright install chromium",
    );
  }

  let browser: import("playwright").Browser;
  try {
    // Optional override to reuse an already-installed Chromium/Chrome instead of downloading one.
    const executablePath = ctx.env.FLOWBRIDGE_BROWSER_EXECUTABLE || undefined;
    browser = await pw.chromium.launch({ headless: step.headless, executablePath });
  } catch (e) {
    throw new FlowBridgeError(
      "BROWSER_UNAVAILABLE",
      `Could not launch Chromium (${(e as Error).message.split("\n")[0]}). Run: npx playwright install chromium`,
      { cause: e },
    );
  }

  try {
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    // Keep the page on its starting origin; block everything else (including subresources).
    await context.route("**/*", (route) => {
      const u = new URL(route.request().url());
      const ok = u.protocol === "data:" || u.protocol === "about:" || u.origin === startUrl.origin || (startUrl.protocol === "file:" && u.protocol === "file:");
      return ok ? route.continue() : route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    page.setDefaultTimeout(step.timeoutMs);
    await page.goto(start, { waitUntil: "load" });

    const extracted: Record<string, string | null> = {};
    for (const [i, a] of step.actions.entries()) {
      try {
        switch (a.action) {
          case "fill": await page.fill(a.selector, a.value); break;
          case "select": await page.selectOption(a.selector, a.value); break;
          case "check": await page.check(a.selector); break;
          case "click": await page.click(a.selector); break;
          case "waitFor": await page.waitForSelector(a.selector); break;
          case "extract": {
            const loc = page.locator(a.selector).first();
            await loc.waitFor();
            extracted[a.name] = a.attribute ? await loc.getAttribute(a.attribute) : ((await loc.textContent()) ?? "").trim();
            break;
          }
        }
      } catch (e) {
        throw new FlowBridgeError("BROWSER_ERROR", `action #${i + 1} (${a.action} ${a.selector}) failed: ${(e as Error).message.split("\n")[0]}`, { cause: e });
      }
    }
    return { data: { ...extracted }, summary: `${step.actions.length} actions, ${Object.keys(extracted).length} values extracted` };
  } finally {
    await browser.close();
  }
}
