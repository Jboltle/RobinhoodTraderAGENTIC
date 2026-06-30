type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const minLevel: Level = (process.env.LOG_LEVEL as Level) ?? 'info';
const minRank = LEVEL_RANK[minLevel] ?? LEVEL_RANK.info;

function emit(level: Level, scope: string, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < minRank) return;
  const line: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    scope,
    message,
  };
  if (meta) Object.assign(line, meta);
  const target = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  target.write(`${JSON.stringify(line)}\n`);
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(subscope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (msg, meta) => emit('debug', scope, msg, meta),
    info: (msg, meta) => emit('info', scope, msg, meta),
    warn: (msg, meta) => emit('warn', scope, msg, meta),
    error: (msg, meta) => emit('error', scope, msg, meta),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
