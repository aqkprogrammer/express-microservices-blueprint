import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runWithContext } from './context.js';
import { classifyError, serializeError } from './errors.js';
import { createLogger } from './logger.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  return { lines, destination };
}

describe('createLogger', () => {
  it('writes structured JSON with service metadata and correlation fields', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 'test-svc', environment: 'test', destination });
    runWithContext({ requestId: 'req-1', correlationId: 'corr-1', causationId: 'evt-0' }, () => {
      logger.info({ orderId: 'o-1' }, 'order created');
    });
    expect(lines[0]).toMatchObject({
      level: 'info',
      service: 'test-svc',
      env: 'test',
      message: 'order created',
      requestId: 'req-1',
      correlationId: 'corr-1',
      causationId: 'evt-0',
      orderId: 'o-1',
    });
  });

  it('redacts secrets and credentials', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 'test-svc', destination });
    logger.info(
      {
        password: 'hunter2',
        body: { refreshToken: 'rt-value-1', token: 'tok-value-2' },
        req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1' } },
      },
      'sensitive',
    );
    const serialized = JSON.stringify(lines[0]);
    for (const secret of ['hunter2', 'rt-value-1', 'tok-value-2', 'Bearer abc', 'sid=1']) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('[REDACTED]');
  });
});

describe('error helpers', () => {
  it('serializes nested causes', () => {
    const error = new Error('outer', { cause: new Error('inner') });
    expect(serializeError(error)).toMatchObject({ message: 'outer', cause: { message: 'inner' } });
    expect(serializeError('plain')).toEqual({ type: 'string', message: 'plain' });
  });

  it('classifies errors into bounded classes', () => {
    expect(classifyError({ status: 400 })).toBe('validation');
    expect(classifyError({ status: 503 })).toBe('dependency');
    expect(classifyError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timeout');
    expect(classifyError(new Error('boom'))).toBe('internal');
  });
});
