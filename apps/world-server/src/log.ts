/**
 * 구조화 JSON 로그 (Phase 3A §28). 한 줄 = 한 JSON. 민감정보 없음.
 * 필수 필드: timestamp, level, service, event (+ dropId, jobId, worldVersion, duration 가 있으면).
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogFields { dropId?: string | null; jobId?: string | null; worldVersion?: number; duration?: number; [k: string]: unknown }

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";
let sink: (line: string) => void = (line) => { process.stdout.write(line + "\n"); };
const service = process.env.LOG_SERVICE ?? "world-server";

export function setLogLevel(l: LogLevel): void { minLevel = l; }
export function setLogSink(fn: (line: string) => void): void { sink = fn; }

function write(level: LogLevel, event: string, fields: LogFields = {}): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const rec: Record<string, unknown> = { timestamp: new Date().toISOString(), level, service, event };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) rec[k] = v instanceof Error ? { message: v.message, name: v.name } : v;
  sink(JSON.stringify(rec));
}
export const log = {
  debug: (event: string, f?: LogFields): void => write("debug", event, f),
  info: (event: string, f?: LogFields): void => write("info", event, f),
  warn: (event: string, f?: LogFields): void => write("warn", event, f),
  error: (event: string, f?: LogFields): void => write("error", event, f),
};
