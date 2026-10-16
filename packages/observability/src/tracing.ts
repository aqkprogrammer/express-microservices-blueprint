import { SpanKind, SpanStatusCode, context, propagation, trace, type Context } from '@opentelemetry/api';

export { SpanKind };

export type TraceCarrier = Record<string, unknown>;

const tracer = () => trace.getTracer('@emb/observability');

/** Writes W3C `traceparent`/`tracestate` for the active context into a header carrier. */
export function injectTraceHeaders<T extends TraceCarrier>(carrier: T, ctx: Context = context.active()): T {
  propagation.inject(ctx, carrier);
  return carrier;
}

export function extractTraceContext(carrier: TraceCarrier | undefined): Context {
  if (!carrier) return context.active();
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(carrier)) {
    if (typeof value === 'string') normalized[key] = value;
    else if (Buffer.isBuffer(value)) normalized[key] = value.toString('utf8');
  }
  return propagation.extract(context.active(), normalized);
}

export function currentTraceparent(): Record<string, string> {
  return injectTraceHeaders<Record<string, string>>({});
}

/**
 * Runs `fn` inside a new span, recording exceptions and status. Used for
 * messaging spans where no auto-instrumentation exists.
 */
export async function withSpan<T>(
  name: string,
  options: { kind?: SpanKind; parent?: Context; attributes?: Record<string, string | number | boolean> },
  fn: () => Promise<T>,
): Promise<T> {
  const parent = options.parent ?? context.active();
  const span = tracer().startSpan(
    name,
    {
      kind: options.kind ?? SpanKind.INTERNAL,
      ...(options.attributes ? { attributes: options.attributes } : {}),
    },
    parent,
  );
  return context.with(trace.setSpan(parent, span), async () => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}
