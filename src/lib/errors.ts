export type ErrorCode =
  | "CONFIG_INVALID"
  | "ENV_MISSING"
  | "INPUT_INVALID"
  | "URL_BLOCKED"
  | "PATH_BLOCKED"
  | "HTTP_ERROR"
  | "HTTP_TIMEOUT"
  | "HTTP_NETWORK"
  | "RESPONSE_INVALID"
  | "DATA_INVALID"
  | "DB_ERROR"
  | "BROWSER_ERROR"
  | "BROWSER_UNAVAILABLE";

/** Base class for every expected, user-facing failure. */
export class FlowBridgeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "FlowBridgeError";
  }
}

export class ConfigError extends FlowBridgeError {
  constructor(message: string, code: ErrorCode = "CONFIG_INVALID") {
    super(code, message);
    this.name = "ConfigError";
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
