import { context, propagation, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { describe, expect, it, beforeAll } from 'vitest';
import { counter, metricsRegistry } from './metrics.js';
import { extractTraceContext, injectTraceHeaders } from './tracing.js';

describe('trace propagation helpers', () => {
  beforeAll(() => {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  });

  it('round-trips a W3C traceparent through a header carrier', () => {
    const spanContext = {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      traceFlags: 1,
      isRemote: true,
    };
    const ctx = trace.setSpanContext(context.active(), spanContext);
    const headers = injectTraceHeaders<Record<string, string>>({}, ctx);
    expect(headers.traceparent).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');

    const extracted = trace.getSpanContext(
      extractTraceContext({ traceparent: Buffer.from(headers.traceparent!) }),
    );
    expect(extracted?.traceId).toBe(spanContext.traceId);
  });
});

describe('metric factories', () => {
  it('reuses an already-registered metric instead of throwing', () => {
    const first = counter('test_reuse_total', 'test', ['outcome']);
    const second = counter('test_reuse_total', 'test', ['outcome']);
    expect(first).toBe(second);
    expect(metricsRegistry.getSingleMetric('test_reuse_total')).toBe(first);
  });
});
