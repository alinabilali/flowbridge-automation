import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { csvSchema, jsonSchema, runCsv, runJson } from "../src/steps/output.js";
import { makeCtx } from "./helpers.js";

const rows = [
  { name: "Ada", email: "a@x.io", company: { name: "Engines, Inc." } },
  { name: "=SUM(1,2)", email: "b@x.io" },
  { name: 'Quote "Q"', email: "c@x.io", company: { name: "Z" } },
];
const csv = (o: object) => csvSchema.parse({ id: "c", type: "csv", input: "src", output: "out/users.csv", ...o });

describe("csv output", () => {
  it("writes nested fields with custom headers, quoting, and creates directories", () => {
    const ctx = makeCtx();
    runCsv(csv({ fields: ["name", { path: "company.name", header: "company" }] }), rows, ctx);
    const text = fs.readFileSync(path.join(ctx.rootDir, "out/users.csv"), "utf8");
    expect(text.split("\n")[0]).toBe("name,company");
    expect(text).toContain('Ada,"Engines, Inc."');
    expect(text).toContain('"Quote ""Q"""');
  });

  it("neutralises spreadsheet formulas unless disabled", () => {
    const ctx = makeCtx();
    runCsv(csv({ fields: ["name"] }), rows, ctx);
    expect(fs.readFileSync(path.join(ctx.rootDir, "out/users.csv"), "utf8")).toContain("'=SUM(1,2)");
    runCsv(csv({ fields: ["name"], sanitizeFormulas: false }), rows, ctx);
    expect(fs.readFileSync(path.join(ctx.rootDir, "out/users.csv"), "utf8")).toContain('"=SUM(1,2)"');
  });

  it("derives columns from all records when no fields are given, leaving gaps empty", () => {
    const ctx = makeCtx();
    runCsv(csv({}), [{ a: 1 }, { b: 2 }], ctx);
    expect(fs.readFileSync(path.join(ctx.rootDir, "out/users.csv"), "utf8")).toBe("a,b\n1,\n,2\n");
  });

  it("rejects non-record input", () => {
    expect(() => runCsv(csv({}), "text", makeCtx())).toThrow(/array of objects/);
  });
});

describe("json output", () => {
  it("projects fields and writes valid JSON", () => {
    const ctx = makeCtx();
    const step = jsonSchema.parse({ id: "j", type: "json", input: "src", output: "o.json", fields: [{ path: "company.name", header: "co" }] });
    runJson(step, rows, ctx);
    expect(JSON.parse(fs.readFileSync(path.join(ctx.rootDir, "o.json"), "utf8"))).toEqual([{ co: "Engines, Inc." }, { co: null }, { co: "Z" }]);
  });
});

describe("output path safety", () => {
  it.each(["../escape.csv", "/etc/flowbridge-test.csv", "out/../../escape.csv"])("blocks %s", (p) => {
    expect(() => runCsv(csv({ output: p }), rows, makeCtx())).toThrow(/outside the allowed directory/);
  });

  it("blocks writes through a symlink that points outside the root", () => {
    const ctx = makeCtx();
    const outside = makeCtx().rootDir;
    fs.symlinkSync(outside, path.join(ctx.rootDir, "link"));
    expect(() => runCsv(csv({ output: "link/x.csv" }), rows, ctx)).toThrow(/outside the allowed directory/);
    expect(fs.existsSync(path.join(outside, "x.csv"))).toBe(false);
  });
});
