import { ConfigError } from "./errors.js";

const PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/**
 * Deeply replace `${NAME}` in every string with process.env.NAME.
 * Missing variables raise a ConfigError naming the variable (never its value).
 * Values substituted are reported through `onSecret` so the logger can mask them.
 */
export function interpolateEnv<T>(value: T, env: NodeJS.ProcessEnv, onSubstitute?: (v: string) => void): T {
  if (typeof value === "string") {
    return value.replace(PATTERN, (_m, name: string) => {
      const v = env[name];
      if (v === undefined || v === "") throw new ConfigError(`Environment variable ${name} is not set`, "ENV_MISSING");
      onSubstitute?.(v);
      return v;
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v, env, onSubstitute)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, interpolateEnv(v, env, onSubstitute)]),
    ) as T;
  }
  return value;
}
