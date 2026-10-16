import { trace } from '@opentelemetry/api';
import { pino, type Logger as PinoLogger, type LoggerOptions as PinoOptions } from 'pino';
import { getRequestContext } from './context.js';

export type Logger = PinoLogger;

export interface LoggerOptions {
  service: string;
  environment?: string;
  level?: string;
  /** Extra redaction paths on top of the defaults. */
  redact?: string[];
  /** Destination stream, mainly for tests. */
  destination?: NodeJS.WritableStream;
}

/**
 * Paths removed from every log line. Pino applies these with fast-redact, so the
 * values never reach stdout, Loki or any other sink.
 */
export const REDACT_PATHS = [
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'resetToken',
  'secret',
  'authorization',
  'cookie',
  '*.password',
  '*.newPassword',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.resetToken',
  '*.secret',
  '*.authorization',
  '*.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-internal-token"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-internal-token"]',
];

export function createLogger(options: LoggerOptions): Logger {
  const pinoOptions: PinoOptions = {
    level: options.level ?? 'info',
    base: { service: options.service, env: options.environment ?? process.env.NODE_ENV ?? 'development' },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'message',
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: { paths: [...REDACT_PATHS, ...(options.redact ?? [])], censor: '[REDACTED]' },
    mixin() {
      const fields: Record<string, string> = {};
      const context = getRequestContext();
      if (context) {
        fields.requestId = context.requestId;
        fields.correlationId = context.correlationId;
        if (context.causationId) fields.causationId = context.causationId;
        if (context.userId) fields.userId = context.userId;
      }
      const spanContext = trace.getActiveSpan()?.spanContext();
      if (spanContext) {
        fields.traceId = spanContext.traceId;
        fields.spanId = spanContext.spanId;
      }
      return fields;
    },
  };
  return options.destination ? pino(pinoOptions, options.destination) : pino(pinoOptions);
}
