import { redact } from "./redact";

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.GATEKEEPER_LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;
const silent = process.env.GATEKEEPER_LOG_LEVEL === "silent" || process.env.VITEST === "true";

/**
 * Structured JSON logs written to stderr. stdout is reserved because the stdio
 * MCP transport uses it for protocol messages.
 */
export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  if (silent || LEVELS[level] < threshold) return;
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...redact(fields) })}\n`,
  );
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => log("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => log("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => log("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => log("error", msg, fields),
};
