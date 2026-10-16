import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * One registry per process. Metric names are prefixed by convention
 * (`http_`, `messaging_`, `outbox_`, `saga_`, `cache_`, `db_`) and every label
 * must be low-cardinality: never put user, order or message IDs in labels.
 */
export const metricsRegistry = new Registry();
let defaultsCollected = false;

export function enableDefaultMetrics(serviceName: string): void {
  if (defaultsCollected) return;
  metricsRegistry.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({ register: metricsRegistry });
  defaultsCollected = true;
}

export function counter<L extends string>(
  name: string,
  help: string,
  labelNames: readonly L[] = [],
): Counter<L> {
  const existing = metricsRegistry.getSingleMetric(name);
  if (existing) return existing as Counter<L>;
  return new Counter({ name, help, labelNames, registers: [metricsRegistry] });
}

export function histogram<L extends string>(
  name: string,
  help: string,
  labelNames: readonly L[] = [],
  buckets: number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
): Histogram<L> {
  const existing = metricsRegistry.getSingleMetric(name);
  if (existing) return existing as Histogram<L>;
  return new Histogram({ name, help, labelNames, buckets, registers: [metricsRegistry] });
}

export function gauge<L extends string>(
  name: string,
  help: string,
  labelNames: readonly L[] = [],
  collect?: (this: Gauge<L>) => void | Promise<void>,
): Gauge<L> {
  const existing = metricsRegistry.getSingleMetric(name);
  if (existing) return existing as Gauge<L>;
  return new Gauge({ name, help, labelNames, registers: [metricsRegistry], ...(collect ? { collect } : {}) });
}

export async function renderMetrics(): Promise<{ contentType: string; body: string }> {
  return { contentType: metricsRegistry.contentType, body: await metricsRegistry.metrics() };
}

export function resetMetricsForTests(): void {
  metricsRegistry.resetMetrics();
}
