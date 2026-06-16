import pino from "pino";

/**
 * Logger writes to **stderr only**. stdout is reserved for the MCP JSON-RPC
 * stream on the stdio transport — writing anything else there corrupts the
 * protocol. Never use console.log in this project.
 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "silent";

export interface LogOptions {
  level?: LogLevel;
  /** Optional file path. When set, logs go to the file instead of stderr. */
  file?: string;
}

export function createLogger(opts: LogOptions = {}): pino.Logger {
  const level = opts.level ?? "info";
  const destination = opts.file
    ? pino.destination({ dest: opts.file, sync: false })
    : pino.destination(2); // fd 2 = stderr
  return pino({ level }, destination);
}

export type Logger = pino.Logger;
