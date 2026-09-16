export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  level: LogLevel;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** `json` prints one JSON object per line (default for `serve`); `pretty` is for humans. */
  format?: "json" | "pretty";
  stream?: NodeJS.WritableStream;
  base?: Record<string, unknown>;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? (process.env.SKILLHOOK_LOG_LEVEL as LogLevel | undefined) ?? "info";
  const format = options.format ?? "json";
  const stream = options.stream ?? process.stderr;
  const base = options.base ?? {};

  function write(entryLevel: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVELS[entryLevel] < LEVELS[level]) return;
    const entry = { ts: new Date().toISOString(), level: entryLevel, msg, ...base, ...fields };
    if (format === "json") {
      stream.write(`${JSON.stringify(entry)}\n`);
    } else {
      const extra = { ...base, ...fields };
      const suffix = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : "";
      stream.write(`${entry.ts} ${entryLevel.toUpperCase().padEnd(5)} ${msg}${suffix}\n`);
    }
  }

  const logger: Logger = {
    level,
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    child: (fields) => createLogger({ level, format, stream, base: { ...base, ...fields } }),
  };
  return logger;
}

export const silentLogger: Logger = {
  level: "error",
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
