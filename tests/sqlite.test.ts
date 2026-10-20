import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runSqliteInsert, runSqliteQuery, sqliteInsertSchema, sqliteQuerySchema } from "../src/steps/sqlite.js";
import { makeCtx } from "./helpers.js";

const insert = (o: object = {}) =>
  sqliteInsertSchema.parse({
    id: "s", type: "sqlite-insert", input: "src", database: "t.db", table: "users",
    columns: { id: { type: "INTEGER", primaryKey: true }, name: { type: "TEXT", required: true }, city: { from: "address.city" }, score: { type: "REAL" } },
    ...o,
  });
const query = (sql: string, params: (string | number)[] = []) => sqliteQuerySchema.parse({ id: "q", type: "sqlite-query", database: "t.db", sql, params });
const count = (ctx: { rootDir: string }) => (new DatabaseSync(path.join(ctx.rootDir, "t.db"), { readOnly: true }).prepare("SELECT COUNT(*) c FROM users").get() as { c: number }).c;

describe("sqlite-insert", () => {
  it("creates the table, persists heterogeneous records, and is queryable", () => {
    const ctx = makeCtx();
    const out = runSqliteInsert(insert(), [{ id: 1, name: "A", address: { city: "X" }, score: "1.5" }, { id: 2, name: "B" }], ctx);
    expect(out.data).toMatchObject({ inserted: 2, rejected: 0 });
    const rows = runSqliteQuery(query("SELECT id, name, city, score FROM users ORDER BY id"), ctx).data;
    expect(rows).toEqual([{ id: 1, name: "A", city: "X", score: 1.5 }, { id: 2, name: "B", city: null, score: null }]);
  });

  it("rejects a bad batch atomically (nothing written)", () => {
    const ctx = makeCtx();
    runSqliteInsert(insert(), [{ id: 1, name: "ok" }], ctx);
    expect(() => runSqliteInsert(insert(), [{ id: 2, name: "fine" }, { id: 3 }], ctx)).toThrow(/record 1.*name/);
    expect(count(ctx)).toBe(1);
  });

  it("validates types and can skip invalid records", () => {
    const ctx = makeCtx();
    const out = runSqliteInsert(insert({ onInvalid: "skip" }), [{ id: "abc", name: "bad id" }, { id: 1.5, name: "float" }, { id: 7, name: "good" }], ctx);
    expect(out.data).toMatchObject({ inserted: 1, rejected: 2 });
    expect(count(ctx)).toBe(1);
  });

  it("handles conflicts per policy and rolls back on failure", () => {
    const ctx = makeCtx();
    runSqliteInsert(insert(), [{ id: 1, name: "first" }], ctx);
    expect(() => runSqliteInsert(insert(), [{ id: 2, name: "x" }, { id: 1, name: "dup" }], ctx)).toThrow(/SQLite insert into users failed.*UNIQUE|constraint/i);
    expect(count(ctx)).toBe(1);
    expect(runSqliteInsert(insert({ onConflict: "ignore" }), [{ id: 1, name: "dup" }], ctx).data).toMatchObject({ inserted: 0, ignored: 1 });
    runSqliteInsert(insert({ onConflict: "replace" }), [{ id: 1, name: "replaced" }], ctx);
    expect(runSqliteQuery(query("SELECT name FROM users"), ctx).data).toEqual([{ name: "replaced" }]);
  });

  it("stores hostile values as data, not SQL", () => {
    const ctx = makeCtx();
    runSqliteInsert(insert(), [{ id: 1, name: "x'); DROP TABLE users;--" }], ctx);
    expect(runSqliteQuery(query("SELECT name FROM users"), ctx).data).toEqual([{ name: "x'); DROP TABLE users;--" }]);
  });

  it("blocks database paths outside the root", () => {
    expect(() => runSqliteInsert(insert({ database: "../evil.db" }), [{ id: 1, name: "a" }], makeCtx())).toThrow(/outside the allowed directory/);
  });

  it("wraps database errors", () => {
    const ctx = makeCtx();
    fs.writeFileSync(path.join(ctx.rootDir, "t.db"), "this is not a sqlite database");
    expect(() => runSqliteInsert(insert(), [{ id: 1, name: "a" }], ctx)).toThrowError(expect.objectContaining({ code: "DB_ERROR" }));
  });
});

describe("sqlite-query", () => {
  it("uses bound parameters", () => {
    const ctx = makeCtx();
    runSqliteInsert(insert(), [{ id: 1, name: "A" }, { id: 2, name: "B" }], ctx);
    expect(runSqliteQuery(query("SELECT name FROM users WHERE id = ?", [2]), ctx).data).toEqual([{ name: "B" }]);
    expect(runSqliteQuery(query("SELECT name FROM users WHERE name = ?", ["A' OR '1'='1"]), ctx).data).toEqual([]);
  });

  it("only accepts read statements and cannot modify data", () => {
    const ctx = makeCtx();
    runSqliteInsert(insert(), [{ id: 1, name: "A" }], ctx);
    expect(() => runSqliteQuery(query("DELETE FROM users"), ctx)).toThrow(/only accepts SELECT/);
    expect(() => runSqliteQuery(query("WITH x AS (SELECT 1) DELETE FROM users"), ctx)).toThrowError(expect.objectContaining({ code: "DB_ERROR" }));
    expect(count(ctx)).toBe(1);
  });

  it("reports a missing database", () => {
    expect(() => runSqliteQuery(query("SELECT 1"), makeCtx())).toThrow(/does not exist/);
  });
});
