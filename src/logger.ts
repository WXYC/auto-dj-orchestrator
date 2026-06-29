/**
 * Structured logger. Secrets are redacted. A long-running service needs logging
 * + error handling on every meaningful transition (global convention).
 */
import { pino } from 'pino';

export type Logger = ReturnType<typeof pino>;

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: [
        'AUTO_DJ_KEY',
        'AUTO_DJ_PASSWORD',
        'password',
        '*.password',
        'token',
        '*.token',
        'authorization',
      ],
      censor: '[redacted]',
    },
  });
}
