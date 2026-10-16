import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { register } from 'node:module';
import { enableDefaultMetrics } from './metrics.js';

export interface TelemetryOptions {
  serviceName: string;
  /** Defaults to OTEL_SDK_DISABLED !== 'true'. */
  tracingEnabled?: boolean;
  /** Ship Pino logs via OTLP (e.g. to Loki). Defaults to OTEL_LOGS_EXPORTER === 'otlp'. */
  logExportEnabled?: boolean;
}

export interface TelemetryHandle {
  shutdown(): Promise<void>;
}

const IGNORED_PATHS = ['/health/live', '/health/ready', '/metrics'];

/**
 * Starts the OpenTelemetry SDK. Must run before the instrumented libraries are
 * loaded, so services preload it with `node --import ./dist/telemetry.js`.
 * Exporter endpoints use the standard OTEL_EXPORTER_OTLP_* variables.
 */
export function startTelemetry(options: TelemetryOptions): TelemetryHandle {
  enableDefaultMetrics(options.serviceName);
  const tracingEnabled = options.tracingEnabled ?? process.env.OTEL_SDK_DISABLED !== 'true';
  if (!tracingEnabled) return { shutdown: () => Promise.resolve() };

  // Services are ES modules: libraries they `import` (pino, ioredis, ...) are only
  // patchable through OpenTelemetry's ESM loader hook (import-in-the-middle).
  // It must be registered before the application modules are loaded, which is
  // why this module is preloaded with `node --import`.
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

  const logExportEnabled = options.logExportEnabled ?? process.env.OTEL_LOGS_EXPORTER === 'otlp';
  const sdk = new NodeSDK({
    serviceName: options.serviceName,
    traceExporter: new OTLPTraceExporter(),
    logRecordProcessors: logExportEnabled
      ? [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })]
      : [],
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => IGNORED_PATHS.some((path) => request.url?.startsWith(path)),
      }),
      new ExpressInstrumentation(),
      new UndiciInstrumentation(),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      new IORedisInstrumentation(),
      // Our logger mixin already adds trace IDs; this instrumentation only forwards records to OTLP.
      new PinoInstrumentation({ disableLogCorrelation: true, disableLogSending: !logExportEnabled }),
    ],
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}
