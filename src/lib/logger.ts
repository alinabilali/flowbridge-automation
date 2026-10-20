export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const SENSITIVE_QUERY = /^(token|access_token|api[-_]?key|key|secret|password|sig|signature|auth)$/i;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Register a secret value so it is masked in all later output. */
  addSecret(value: string): void;
  /** Mask secrets and sensitive URL query values in arbitrary text. */
  redact(text: string): string;
}

export interface LoggerOptions {
  level?: LogLevel;
  json?: boolean;
  color?: boolean;
  write?: (line: string) => void;
}

export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = u.username ? "***" : "";
    u.password = "";
    for (const k of [...u.searchParams.keys()]) {
      if (SENSITIVE_QUERY.test(k)) u.searchParams.set(k, "***");
    }
    return u.toString();
  } catch {
    return raw;
  }
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const min = ORDER[opts.level ?? "info"];
  const write = opts.write ?? ((l: string) => process.stdout.write(l + "\n"));
  const secrets = new Set<string>();
  const c = (code: number, s: string) => (opts.color ? `\x1b[${code}m${s}\x1b[0m` : s);

  const redact = (text: string): string => {
    let out = text;
    for (const s of secrets) out = out.split(s).join("***");
    return out;
  };

  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    if (opts.json) {
      write(redact(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields })));
      return;
    }
    const tag =
      level === "error" ? c(31, "✗") : level === "warn" ? c(33, "!") : level === "debug" ? c(90, "·") : c(32, "✓");
    const extra =
      fields && Object.keys(fields).length
        ? c(90, " " + Object.entries(fields).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" "))
        : "";
    write(redact(`${tag} ${msg}${extra}`));
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    addSecret: (v) => {
      if (v.length >= 4) secrets.add(v);
    },
    redact,
  };
}
