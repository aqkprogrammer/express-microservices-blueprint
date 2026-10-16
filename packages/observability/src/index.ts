export { startTelemetry, type TelemetryHandle, type TelemetryOptions } from './telemetry.js';
export {
  metricsRegistry,
  counter,
  histogram,
  gauge,
  renderMetrics,
  resetMetricsForTests,
} from './metrics.js';
export {
  injectTraceHeaders,
  extractTraceContext,
  withSpan,
  currentTraceparent,
  SpanKind,
  type TraceCarrier,
} from './tracing.js';
