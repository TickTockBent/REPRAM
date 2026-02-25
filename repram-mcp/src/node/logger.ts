/**
 * Leveled logger — port of internal/logging/logger.go.
 *
 * No external deps. Wraps console with level filtering.
 * Initialize from REPRAM_LOG_LEVEL env var.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const levelOrder: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const levelLabels: Record<LogLevel, string> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
};

function parseLevel(value: string | undefined): LogLevel {
  const normalized = (value ?? "").toLowerCase();
  if (normalized in levelOrder) return normalized as LogLevel;
  return "info";
}

export class Logger {
  private threshold: number;

  constructor(level?: string) {
    const effectiveLevel = parseLevel(level ?? process.env.REPRAM_LOG_LEVEL);
    this.threshold = levelOrder[effectiveLevel];
  }

  debug(msg: string, ...args: unknown[]): void { this.log("debug", msg, ...args); }
  info(msg: string, ...args: unknown[]): void  { this.log("info", msg, ...args); }
  warn(msg: string, ...args: unknown[]): void  { this.log("warn", msg, ...args); }
  error(msg: string, ...args: unknown[]): void { this.log("error", msg, ...args); }

  private log(level: LogLevel, msg: string, ...args: unknown[]): void {
    if (levelOrder[level] < this.threshold) return;

    const timestamp = new Date().toISOString();
    const formatted = args.length > 0 ? `${msg} ${args.map(String).join(" ")}` : msg;
    const line = `${timestamp} [${levelLabels[level]}] ${formatted}`;

    if (level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}
