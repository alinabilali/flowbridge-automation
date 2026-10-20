import fs from "node:fs";
import path from "node:path";
import { FlowBridgeError } from "./errors.js";

/**
 * Resolve a user-supplied file path and make sure it stays inside `root`.
 * Rejects `..` escapes, absolute paths outside the root, and symlink escapes
 * (by resolving the deepest existing ancestor with realpath).
 */
export function resolveInside(root: string, target: string, label = "path"): string {
  if (target.includes("\0")) throw new FlowBridgeError("PATH_BLOCKED", `${label} contains a null byte`);
  const realRoot = fs.realpathSync(root);
  const abs = path.resolve(realRoot, target);

  let existing = abs;
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    tail.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const resolved = path.join(fs.realpathSync(existing), ...tail);
  const rel = path.relative(realRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new FlowBridgeError("PATH_BLOCKED", `${label} "${target}" resolves outside the allowed directory ${realRoot}`);
  }
  return resolved;
}

export function ensureParentDir(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}
