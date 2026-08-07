type Level = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = RANK.info;

export function setLogLevel(level: Level): void {
  threshold = RANK[level];
}

function emit(level: Level, scope: string, message: string, extra: unknown[]): void {
  if (RANK[level] < threshold) return;
  const stamp = new Date().toISOString().slice(11, 23);
  const line = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(line, ...extra);
}

export interface Logger {
  debug(message: string, ...extra: unknown[]): void;
  info(message: string, ...extra: unknown[]): void;
  warn(message: string, ...extra: unknown[]): void;
  error(message: string, ...extra: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, ...e) => emit('debug', scope, m, e),
    info: (m, ...e) => emit('info', scope, m, e),
    warn: (m, ...e) => emit('warn', scope, m, e),
    error: (m, ...e) => emit('error', scope, m, e),
  };
}
