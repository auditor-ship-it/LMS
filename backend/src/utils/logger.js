/**
 * Reusable terminal logger. No external dependency — this app has no logging
 * library today, and the volume/format needed here (leveled, timestamped,
 * prefixed lines) doesn't justify adding one.
 *
 * Levels: debug < info < warn < error. LOG_LEVEL env var sets the minimum
 * level that prints (default 'debug' in development, 'info' otherwise) —
 * the per-query [DB]/[SHEETS] detail logs are emitted at 'debug', so they're
 * the ones LOG_LEVEL=info would silence if the detail gets too noisy.
 */
import { env } from '../config/env.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_LEVEL = env.nodeEnv === 'production' ? 'info' : 'debug';
const currentLevel = LEVELS[String(process.env.LOG_LEVEL || DEFAULT_LEVEL).toLowerCase()] ?? LEVELS.debug;

const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';
const useColor = process.stdout.isTTY;

function timestamp() {
  return new Date().toISOString().split('T')[1].replace('Z', '');
}

function write(level, args) {
  if (LEVELS[level] < currentLevel) return;
  const prefix = `[${timestamp()}] [${level.toUpperCase()}]`;
  const line = useColor ? `${COLORS[level]}${prefix}${RESET}` : prefix;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(line, ...args);
}

export const logger = {
  debug: (...args) => write('debug', args),
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args)
};
