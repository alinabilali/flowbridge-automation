import { describe, expect, it } from "vitest";
import { getPath } from "../src/lib/fields.js";
import { runTransform, transformSchema } from "../src/steps/transform.js";

const step = (o: object) => transformSchema.parse({ id: "t", type: "transform", input: "src", ...o });
const users = [
  { id: 1, name: "A", company: { name: "X" }, tags: ["a", "b"], age: "30" },
  { id: 2, name: "B", age: 12 },
  { id: 3, name: "C", company: null },
];

describe("getPath", () => {
  it("handles nesting, arrays, and missing values", () => {
    expect(getPath(users[0], "company.name")).toBe("X");
    expect(getPath(users[0], "tags[1]")).toBe("b");
    expect(getPath(users[1], "company.name")).toBeUndefined();
    expect(getPath(users[2], "company.name")).toBeUndefined();
  });
  it("does not walk the prototype chain", () => {
    expect(getPath({}, "constructor")).toBeUndefined();
    expect(getPath({}, "__proto__.polluted")).toBeUndefined();
  });
});

describe("transform step", () => {
  it("selects nested fields, tolerating missing ones as null", () => {
    const out = runTransform(step({ select: { name: "name", company: "company.name" } }), users);
    expect(out.data).toEqual([
      { name: "A", company: "X" },
      { name: "B", company: null },
      { name: "C", company: null },
    ]);
  });

  it("applies defaults and type coercion", () => {
    const out = runTransform(step({ select: { company: { from: "company.name", default: "n/a" }, age: { from: "age", as: "number" } } }), users);
    expect(out.data).toEqual([
      { company: "X", age: 30 },
      { company: "n/a", age: 12 },
      { company: "n/a", age: null },
    ]);
  });

  it("fails on missing required fields by default", () => {
    expect(() => runTransform(step({ select: { c: { from: "company.name", required: true } } }), users)).toThrow(/record 1.*company\.name/);
  });

  it("skips invalid records when onInvalid=skip", () => {
    const out = runTransform(step({ onInvalid: "skip", select: { c: { from: "company.name", required: true } } }), users);
    expect(out.data).toEqual([{ c: "X" }]);
    expect(out.summary).toContain("2 skipped");
  });

  it("filters, limits and reads a nested array via path", () => {
    const out = runTransform(step({ path: "data.items", where: [{ field: "id", op: "gte", value: 2 }], limit: 1 }), { data: { items: users } });
    expect(out.data).toEqual([users[1]]);
  });

  it("reports a bad coercion", () => {
    expect(() => runTransform(step({ select: { n: { from: "name", as: "number" } } }), users)).toThrow(/cannot convert/);
  });

  it("rejects non-object input and missing path", () => {
    expect(() => runTransform(step({}), [1, 2])).toThrow(/not an object/);
    expect(() => runTransform(step({ path: "nope" }), {})).toThrow(/not found/);
  });
});
