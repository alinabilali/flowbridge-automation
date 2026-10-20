import { describe, expect, it } from "vitest";
import { parseWorkflow } from "../src/config.js";
import { ConfigError } from "../src/lib/errors.js";

const valid = `
name: demo
version: 1
steps:
  - id: a
    type: http
    url: https://example.com/data
  - id: b
    type: csv
    input: a
    output: ./out.csv
    fields: [name, company.name]
`;

describe("workflow validation", () => {
  it("accepts a valid workflow and applies defaults", () => {
    const wf = parseWorkflow(valid, "yaml");
    expect(wf.steps).toHaveLength(2);
    expect(wf.steps[0]).toMatchObject({ method: "GET", timeoutMs: 10_000 });
  });

  it("accepts JSON", () => {
    const wf = parseWorkflow(JSON.stringify({ name: "j", version: 1, steps: [{ id: "x", type: "http", url: "https://e.com" }] }), "json");
    expect(wf.name).toBe("j");
  });

  const bad = (yaml: string) => () => parseWorkflow(yaml, "yaml");

  it("rejects malformed YAML", () => {
    expect(bad("name: [unclosed")).toThrow(ConfigError);
  });

  it("rejects unknown step types and lists the valid ones", () => {
    expect(bad("name: x\nversion: 1\nsteps:\n  - id: a\n    type: ftp\n")).toThrow(/unknown or missing step type "ftp".*http/s);
  });

  it("rejects a wrong version and missing steps", () => {
    expect(bad("name: x\nversion: 2\nsteps: []\n")).toThrow(/version[\s\S]*steps/);
  });

  it("rejects unknown keys (typos) in a step", () => {
    expect(bad("name: x\nversion: 1\nsteps:\n  - id: a\n    type: http\n    url: https://e.com\n    mehtod: GET\n")).toThrow(/mehtod|Unrecognized/i);
  });

  it("rejects duplicate ids", () => {
    const yaml = valid.replace("id: b", "id: a");
    expect(bad(yaml)).toThrow(/duplicate step id "a"/);
  });

  it("rejects references to undefined or later steps", () => {
    expect(bad(valid.replace("input: a", "input: nope"))).toThrow(/references "nope"/);
    const reordered = `name: x\nversion: 1\nsteps:\n  - id: b\n    type: csv\n    input: a\n    output: o.csv\n  - id: a\n    type: http\n    url: https://e.com\n`;
    expect(bad(reordered)).toThrow(/not defined earlier/);
  });

  it("refuses retries on POST", () => {
    const yaml = "name: x\nversion: 1\nsteps:\n  - id: a\n    type: http\n    method: POST\n    url: https://e.com\n    retries: 3\n";
    expect(bad(yaml)).toThrow(/never retried/);
  });

  it("rejects unsafe SQL identifiers", () => {
    const yaml = `name: x\nversion: 1\nsteps:\n  - id: a\n    type: http\n    url: https://e.com\n  - id: s\n    type: sqlite-insert\n    input: a\n    database: d.db\n    table: "users; DROP TABLE x"\n    columns: { id: {} }\n`;
    expect(bad(yaml)).toThrow(/plain SQL identifier/);
  });

  it("requires exactly one of url/file for browser steps", () => {
    const yaml = "name: x\nversion: 1\nsteps:\n  - id: b\n    type: browser\n    actions: [{ action: click, selector: a }]\n";
    expect(bad(yaml)).toThrow(/exactly one of/);
  });
});
