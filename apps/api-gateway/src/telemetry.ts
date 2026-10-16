// Preloaded with `node --import` so instrumentation patches modules before they load.
import { startTelemetry } from '@emb/observability';

export const telemetry = startTelemetry({ serviceName: 'api-gateway' });
