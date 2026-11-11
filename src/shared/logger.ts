/**
 * Structured logger that writes ONLY to stderr.
 *
 * Every service in this repo logs through this module. That is mandatory for the
 * stdio MCP server (Task 1), where stdout is the JSON-RPC channel, and it is a
 * sensible default for the HTTP services: stdout stays free for program output
 * and log shippers can pick up stderr as JSON lines.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

function write(level: Level, component: string, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, component, msg, ...fields });
  process.stderr.write(line + "\n");
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(component: string): Logger {
  return {
    debug: (m, f) => write("debug", component, m, f),
    info: (m, f) => write("info", component, m, f),
    warn: (m, f) => write("warn", component, m, f),
    error: (m, f) => write("error", component, m, f),
  };
}

/**
 * Defence in depth for stdio transports: re-point every console method that
 * would print to stdout so it prints to stderr instead. A stray console.log
 * from our code or a dependency can then never corrupt the JSON-RPC stream.
 */
export function redirectConsoleToStderr(): void {
  const toStderr = (...args: unknown[]) => console.error(...args);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.dir = toStderr;
  console.table = toStderr;
  console.trace = (...args: unknown[]) => console.error("Trace:", ...args);
}
