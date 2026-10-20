/**
 * Resolve a dotted path such as "company.name" or "items[0].id" against a value.
 * Returns undefined when any segment is missing; never throws.
 */
export function getPath(value: unknown, path: string): unknown {
  if (path === "" || path === ".") return value;
  const segments = path.match(/[^.[\]]+/g) ?? [];
  let current: unknown = value;
  for (const seg of segments) {
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(seg)) return undefined;
      current = current[Number(seg)];
    } else {
      if (!Object.hasOwn(current, seg)) return undefined;
      current = (current as Record<string, unknown>)[seg];
    }
  }
  return current;
}

export type Row = Record<string, unknown>;

export function isRow(v: unknown): v is Row {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Coerce a step input into an array of records, or explain why it cannot be. */
export function toRows(value: unknown, label: string): Row[] {
  const list = Array.isArray(value) ? value : isRow(value) ? [value] : null;
  if (!list) throw new TypeError(`${label} must be an array of objects or a single object`);
  list.forEach((item, i) => {
    if (!isRow(item)) throw new TypeError(`${label} item ${i} is not an object`);
  });
  return list as Row[];
}

/** Flatten a value for CSV/text cells. */
export function toCell(v: unknown): string | number | boolean {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return v as string | number | boolean;
}
