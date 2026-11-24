import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface LoggerOptions {
  file?: string;
  level?: LogLevel;
  /** 同时输出到 stderr（stdio MCP 桥绝不能写 stdout）。 */
  stderr?: boolean;
}

function rotateIfLarge(file: string): void {
  try {
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
      renameSync(file, `${file}.1`);
    }
  } catch {
    // 日志轮转失败不应影响主流程。
  }
}

function serializeError(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

export function createLogger(options: LoggerOptions = {}, scope?: string): Logger {
  const threshold = ORDER[options.level ?? "info"];
  const file = options.file;
  if (file) {
    mkdirSync(dirname(file), { recursive: true });
    rotateIfLarge(file);
  }

  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (ORDER[level] < threshold) return;
    const safeFields: Record<string, unknown> = {};
    if (fields) {
      for (const [key, value] of Object.entries(fields)) safeFields[key] = serializeError(value);
    }
    const line = JSON.stringify({ t: new Date().toISOString(), level, ...(scope ? { scope } : {}), msg: message, ...safeFields });
    if (file) {
      try {
        appendFileSync(file, `${line}\n`);
      } catch {
        // 忽略写日志失败。
      }
    }
    if (options.stderr) process.stderr.write(`${line}\n`);
  };

  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (childScope) => createLogger(options, scope ? `${scope}.${childScope}` : childScope),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
