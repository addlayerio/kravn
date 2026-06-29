import { pino, type Logger } from 'pino';
import type { Env } from './config/env.js';

export function createLogger(env: Env): Logger {
  return pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: env.isProd
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', '*.authValue', '*.password', '*.token'],
      censor: '[redacted]',
    },
  });
}

export type { Logger };
