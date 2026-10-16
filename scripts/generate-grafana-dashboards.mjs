#!/usr/bin/env node
// Generates the provisioned Grafana dashboards from compact panel definitions.
// Usage: node scripts/generate-grafana-dashboards.mjs
import { writeFileSync } from 'node:fs';

const DS = { type: 'prometheus', uid: 'prometheus' };
let nextId = 1;

function panel({
  title,
  type = 'timeseries',
  exprs,
  unit = 'short',
  w = 12,
  h = 8,
  x = 0,
  y = 0,
  description,
  legend = true,
  stack = false,
}) {
  return {
    id: nextId++,
    type,
    title,
    description,
    datasource: DS,
    gridPos: { w, h, x, y },
    fieldConfig: {
      defaults: {
        unit,
        custom:
          type === 'timeseries'
            ? { lineWidth: 2, fillOpacity: stack ? 30 : 10, stacking: { mode: stack ? 'normal' : 'none' } }
            : undefined,
      },
      overrides: [],
    },
    options:
      type === 'timeseries'
        ? {
            legend: {
              showLegend: legend,
              displayMode: 'table',
              placement: 'bottom',
              calcs: ['lastNotNull', 'max'],
            },
            tooltip: { mode: 'multi' },
          }
        : { reduceOptions: { calcs: ['lastNotNull'] }, colorMode: 'value' },
    targets: exprs.map(([expr, legendFormat], index) => ({
      refId: String.fromCharCode(65 + index),
      datasource: DS,
      expr,
      legendFormat,
    })),
  };
}

function row(title, y) {
  return {
    id: nextId++,
    type: 'row',
    title,
    collapsed: false,
    gridPos: { w: 24, h: 1, x: 0, y },
    panels: [],
  };
}

function dashboard(uid, title, description, panels) {
  return {
    uid,
    title,
    description,
    tags: ['express-microservices-blueprint'],
    timezone: 'browser',
    schemaVersion: 39,
    version: 1,
    refresh: '10s',
    time: { from: 'now-30m', to: 'now' },
    templating: {
      list: [
        {
          name: 'service',
          type: 'query',
          datasource: DS,
          query: 'label_values(http_requests_total, service)',
          includeAll: true,
          multi: true,
          current: { text: 'All', value: '$__all' },
          refresh: 2,
        },
      ],
    },
    panels,
  };
}

nextId = 1;
const svc = 'service=~"$service"';
const ops = 'route!~"/health.*|/metrics"';
const overview = dashboard(
  'emb-services',
  'Services overview (RED)',
  'Request rate, errors and duration per service, plus dependencies.',
  [
    row('HTTP (rate / errors / duration)', 0),
    panel({
      title: 'Requests per second',
      y: 1,
      unit: 'reqps',
      exprs: [[`sum by (service) (rate(http_requests_total{${svc},${ops}}[1m]))`, '{{service}}']],
    }),
    panel({
      title: '5xx error ratio',
      x: 12,
      y: 1,
      unit: 'percentunit',
      exprs: [
        [
          `sum by (service) (rate(http_requests_total{${svc},status_code=~"5.."}[5m])) / sum by (service) (rate(http_requests_total{${svc}}[5m]))`,
          '{{service}}',
        ],
      ],
    }),
    panel({
      title: 'p95 latency by service',
      y: 9,
      unit: 's',
      exprs: [
        [
          `histogram_quantile(0.95, sum by (service, le) (rate(http_request_duration_seconds_bucket{${svc},${ops}}[5m])))`,
          '{{service}}',
        ],
      ],
    }),
    panel({
      title: 'p95 latency by route',
      x: 12,
      y: 9,
      unit: 's',
      exprs: [
        [
          `histogram_quantile(0.95, sum by (service, route, le) (rate(http_request_duration_seconds_bucket{${svc},${ops}}[5m])))`,
          '{{service}} {{route}}',
        ],
      ],
    }),
    panel({
      title: 'Requests in flight',
      y: 17,
      w: 8,
      exprs: [[`sum by (service) (http_requests_in_flight{${svc}})`, '{{service}}']],
    }),
    panel({
      title: '4xx by status',
      x: 8,
      y: 17,
      w: 8,
      stack: true,
      exprs: [
        [
          `sum by (status_code) (rate(http_requests_total{${svc},status_code=~"4.."}[5m]))`,
          '{{status_code}}',
        ],
      ],
    }),
    panel({
      title: 'Gateway upstream errors',
      x: 16,
      y: 17,
      w: 8,
      exprs: [['sum by (upstream, kind) (rate(gateway_upstream_errors_total[5m]))', '{{upstream}} {{kind}}']],
    }),
    row('Dependencies', 25),
    panel({
      title: 'Outgoing HTTP calls (service-to-service)',
      y: 26,
      w: 8,
      exprs: [
        [
          'sum by (service, target, outcome) (rate(http_client_requests_total[5m]))',
          '{{service}} → {{target}} {{outcome}}',
        ],
      ],
    }),
    panel({
      title: 'Open circuits',
      x: 8,
      y: 26,
      w: 8,
      exprs: [
        ['max by (service, target) (http_client_circuit_open)', '{{service}} → {{target}}'],
        ['max by (upstream) (gateway_upstream_circuit_open)', 'gateway → {{upstream}}'],
      ],
    }),
    panel({
      title: 'Product cache results',
      x: 16,
      y: 26,
      w: 8,
      stack: true,
      exprs: [['sum by (cache, result) (rate(cache_requests_total[5m]))', '{{cache}} {{result}}']],
    }),
    panel({
      title: 'DB pool connections',
      y: 34,
      w: 12,
      exprs: [[`sum by (service, state) (db_pool_connections{${svc}})`, '{{service}} {{state}}']],
    }),
    panel({
      title: 'Process memory (RSS)',
      x: 12,
      y: 34,
      w: 12,
      unit: 'bytes',
      exprs: [[`process_resident_memory_bytes{${svc}}`, '{{service}}']],
    }),
  ],
);

nextId = 1;
const messaging = dashboard(
  'emb-messaging',
  'Messaging, outbox & saga',
  'RabbitMQ consumption, retries, dead letters, outbox backlog and order saga outcomes.',
  [
    row('Order saga', 0),
    panel({
      title: 'Saga outcomes',
      y: 1,
      stack: true,
      exprs: [['sum by (outcome, reason) (increase(saga_completed_total[5m]))', '{{outcome}} ({{reason}})']],
    }),
    panel({
      title: 'Saga duration p50 / p95',
      x: 12,
      y: 1,
      unit: 's',
      exprs: [
        ['histogram_quantile(0.5, sum by (le) (rate(saga_duration_seconds_bucket[5m])))', 'p50'],
        ['histogram_quantile(0.95, sum by (le) (rate(saga_duration_seconds_bucket[5m])))', 'p95'],
      ],
    }),
    panel({
      title: 'Saga step timeouts',
      y: 9,
      w: 8,
      exprs: [
        ['sum by (step, decision) (increase(saga_step_timeouts_total[5m]))', '{{step}} → {{decision}}'],
      ],
    }),
    panel({
      title: 'Ignored (stale/duplicate) saga events',
      x: 8,
      y: 9,
      w: 8,
      exprs: [['sum by (event_type) (increase(saga_events_ignored_total[5m]))', '{{event_type}}']],
    }),
    panel({
      title: 'Inventory reservations',
      x: 16,
      y: 9,
      w: 8,
      stack: true,
      exprs: [['sum by (outcome) (increase(inventory_reservations_total[5m]))', '{{outcome}}']],
    }),
    row('Consumers', 17),
    panel({
      title: 'Messages consumed by outcome',
      y: 18,
      stack: true,
      exprs: [
        ['sum by (queue, outcome) (rate(messaging_messages_consumed_total[1m]))', '{{queue}} {{outcome}}'],
      ],
    }),
    panel({
      title: 'Handler duration p95',
      x: 12,
      y: 18,
      unit: 's',
      exprs: [
        [
          'histogram_quantile(0.95, sum by (queue, event_type, le) (rate(messaging_message_processing_duration_seconds_bucket[5m])))',
          '{{queue}} {{event_type}}',
        ],
      ],
    }),
    panel({
      title: 'Retries scheduled',
      y: 26,
      w: 8,
      exprs: [['sum by (queue) (increase(messaging_retries_total[5m]))', '{{queue}}']],
    }),
    panel({
      title: 'Dead-lettered',
      x: 8,
      y: 26,
      w: 8,
      exprs: [
        ['sum by (queue, reason) (increase(messaging_dead_lettered_total[5m]))', '{{queue}} {{reason}}'],
      ],
    }),
    panel({
      title: 'Open dead letters (archive)',
      x: 16,
      y: 26,
      w: 8,
      type: 'stat',
      exprs: [['max(dead_letters_open)', 'open']],
    }),
    panel({
      title: 'Queue depth (ready)',
      y: 34,
      exprs: [
        [
          'sum by (queue) (rabbitmq_detailed_queue_messages_ready or rabbitmq_queue_messages_ready)',
          '{{queue}}',
        ],
      ],
    }),
    panel({
      title: 'Broker connection up',
      x: 12,
      y: 34,
      exprs: [['min by (service) (messaging_connection_up)', '{{service}}']],
    }),
    row('Transactional outbox', 42),
    panel({
      title: 'Outbox rows relayed',
      y: 43,
      w: 8,
      stack: true,
      exprs: [
        ['sum by (service, outcome) (rate(outbox_events_relayed_total[1m]))', '{{service}} {{outcome}}'],
      ],
    }),
    panel({
      title: 'Pending outbox rows',
      x: 8,
      y: 43,
      w: 8,
      exprs: [['max by (service) (outbox_pending_events)', '{{service}}']],
    }),
    panel({
      title: 'Oldest pending outbox age',
      x: 16,
      y: 43,
      w: 8,
      unit: 's',
      exprs: [['max by (service) (outbox_oldest_pending_age_seconds)', '{{service}}']],
    }),
    row('Background worker', 51),
    panel({
      title: 'Scheduled jobs',
      y: 52,
      stack: true,
      exprs: [['sum by (task, outcome) (increase(worker_jobs_total[5m]))', '{{task}} {{outcome}}']],
    }),
    panel({
      title: 'Notifications',
      x: 12,
      y: 52,
      stack: true,
      exprs: [
        [
          'sum by (template, outcome) (increase(notifications_delivered_total[5m]))',
          '{{template}} {{outcome}}',
        ],
      ],
    }),
  ],
);

writeFileSync(
  'infrastructure/grafana/dashboards/services-overview.json',
  `${JSON.stringify(overview, null, 2)}\n`,
);
writeFileSync(
  'infrastructure/grafana/dashboards/messaging-saga.json',
  `${JSON.stringify(messaging, null, 2)}\n`,
);
console.log('Wrote 2 dashboards to infrastructure/grafana/dashboards');
