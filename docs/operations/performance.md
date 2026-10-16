# Performance notes and measured load-test results

These numbers come from **one run on one machine**. They show how the local
stack behaves and where its costs are. They are **not** capacity figures for
any production deployment. Measure on your own hardware and topology before
drawing conclusions.

## How to reproduce

```bash
docker compose up --build -d --wait
# k6 sends every request from one IP, so raise the per-IP limits during the test
RATE_LIMIT_MAX=1000000 AUTH_RATE_LIMIT_MAX=1000 docker compose up -d --wait api-gateway
npm run test:load                         # tests/load/catalog-browse.js
npm run test:load -- order-placement.js   # tests/load/order-placement.js
docker compose up -d --wait api-gateway   # restore the default limits
```

`scripts/run-k6.mjs` runs `grafana/k6:1.2.0` on the Compose network. It writes a
summary to `tests/load/results/` (gitignored). The summaries leave out k6
`setup_data`, so test users' access tokens never reach the disk.

## Environment of the recorded run (2026-10-16)

- Linux VM with 4 vCPUs and 16 GB RAM. All 18 containers and k6 ran on the same host.
- Compose resource limits: each service 0.5 CPU / 256 MB; the gateway 1 CPU; auth 1 CPU.
- OpenTelemetry tracing at 100% sampling (`OTEL_TRACES_SAMPLER_ARG=1.0`).
  Logs are exported to Loki over OTLP. These are the local defaults.
- The data set is the demo seed (8 products) plus earlier test data.

## Results

### Catalog browsing (`catalog-browse.js`)

Each iteration makes three anonymous requests (list, search, detail) at a
target of 50 iterations/s for 30 s.

| Configuration                              | Requests/s | Failed | Median | p90    | p95    | Max     |
| ------------------------------------------ | ---------- | ------ | ------ | ------ | ------ | ------- |
| Default (tracing on, 100% sampling)        | 142        | 0%     | 299 ms | 549 ms | 681 ms | 1572 ms |
| Tracing disabled on gateway + product only | 148        | 0%     | 6 ms   | 74 ms  | 110 ms | 485 ms  |

With tracing on, k6 dropped 73 iterations because it could not keep the target
rate with 100 VUs. With tracing off on those two services it dropped 17. The
scenario's `p(95)<500ms` thresholds failed with tracing on and passed with it off.

### Order placement (`order-placement.js`)

10 virtual users run for 30 s. Each iteration places an order (`POST
/api/v1/orders`, which starts the saga) and then reads it back.

| Metric                                 | Value                                      |
| -------------------------------------- | ------------------------------------------ |
| Orders accepted                        | 237 (≈7.3/s)                               |
| Failed HTTP requests                   | 0%                                         |
| `POST /orders` latency median / p95    | 527 ms / 1195 ms                           |
| Orders in a terminal state after ~25 s | all CONFIRMED (none stuck or in review)    |
| Saga duration p95 during the burst     | ≈29 s (Prometheus `saga_duration_seconds`) |

The order API stays responsive because the saga is asynchronous. Under a
burst, the queues absorb the work, and sagas finish later as the CPU-limited
consumers catch up. You can watch this on the _Messaging, outbox & saga_
Grafana dashboard. The saga p95 comes from histogram buckets (10 s, 30 s), so it
is approximate.

## What the numbers say

- **Tracing cost dominates on small CPU budgets.** With 100% sampling, every
  request creates spans for HTTP, each Express middleware, fetch, pg and ioredis.
  Pino log records are also exported over OTLP. On containers limited to half a
  CPU, that work costs far more than the request itself. In production, sample
  with `OTEL_TRACES_SAMPLER=parentbased_traceidratio` and an
  `OTEL_TRACES_SAMPLER_ARG` such as `0.05`, or use tail sampling in an
  OpenTelemetry Collector. Consider shipping logs from stdout instead of OTLP.
- **The gateway is on every request.** Give it more CPU than the services and
  scale it horizontally first. It is stateless; rate-limit counters live in
  Redis.
- **Saga throughput depends on consumer capacity.** Prefetch, replica count and
  database pool size bound it (see the `CONSUMER_PREFETCH` and
  `DATABASE_POOL_SIZE` variables). The outbox relays and consumers are safe to
  run with several replicas: claims use `FOR UPDATE SKIP LOCKED` and consumers
  are idempotent.
- **Product reads are cached.** Cache-aside on Redis serves repeated list and
  detail reads. Watch `cache_requests_total` to see the hit ratio.
