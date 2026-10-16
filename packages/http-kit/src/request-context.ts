import { randomUUID } from 'node:crypto';
import { runWithContext } from '@emb/logger';
import type { RequestHandler } from 'express';

/** Only accept caller-supplied IDs that are safe to log and echo back. */
export const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const pick = (value: string | string[] | undefined): string | undefined => {
  const single = Array.isArray(value) ? value[0] : value;
  return single && SAFE_ID_PATTERN.test(single) ? single : undefined;
};

/**
 * Establishes request/correlation IDs for the request and runs the rest of the
 * chain inside an AsyncLocalStorage scope so logs and outgoing calls carry them.
 */
export const requestContextMiddleware: RequestHandler = (req, res, next) => {
  const requestId = pick(req.headers['x-request-id']) ?? randomUUID();
  const correlationId = pick(req.headers['x-correlation-id']) ?? requestId;
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Correlation-Id', correlationId);
  runWithContext({ requestId, correlationId }, () => {
    next();
  });
};
