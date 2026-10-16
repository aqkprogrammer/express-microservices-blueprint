# ADR-0007: Redis is not the system of record

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

Three features benefit from a fast shared in-memory store: product read caching, gateway rate limiting shared across replicas, and electing a single scheduler among worker replicas. If Redis also held business state, its availability and durability would become critical to correctness.

## Decision

Redis 8 holds **only derived or disposable data**. Locally it runs with persistence disabled (`--save '' --appendonly no`), `maxmemory 128mb` and `allkeys-lru` eviction, so losing every key at any time must be harmless.

| Use                         | Implementation                                                                                                                                                                                                                 | Behaviour when Redis is unavailable                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product cache (cache-aside) | `apps/product-service/src/cache/product-cache.ts`: detail TTL 300 s, list TTL 60 s, ±10 % jitter; list invalidation by bumping a generation counter; single-flight per process plus a short `SET NX PX` lock against stampedes | **Fail open**: every Redis error falls through to PostgreSQL (`cache_requests_total{result="bypass"\|"error"}`); readiness reports the cache as a non-critical check. |
| Gateway rate limits         | `express-rate-limit` with a Redis store, 300 requests/min/IP globally and 20/min/IP on login, register, refresh and password reset                                                                                             | **Fail open** (`passOnStoreError: true`): requests pass without rate limiting.                                                                                        |
| Scheduler leader lock       | `apps/worker/src/scheduler/scheduler.ts`: `SET worker:scheduler:<task> <instance> PX <0.9 × interval> NX`                                                                                                                      | **Fail open**: every replica publishes (`worker_jobs_total{outcome="published_without_lock"}`); all maintenance tasks are idempotent, so duplicates are harmless.     |

Nothing else uses Redis. Sessions, refresh tokens, idempotency records and messaging state live in PostgreSQL.

## Consequences

### Positive

- Redis outages degrade performance and protections; they do not lose data or block orders.
- No Redis backup or persistence tuning is required.

### Negative and trade-offs

- **Fail-open rate limiting is a security trade-off**: during a Redis outage, credential endpoints are not rate-limited at the gateway. Account lockout in auth-service (5 failures → 15 min, stored in PostgreSQL) still applies. Deployments that prefer fail-closed should change `passOnStoreError` and accept that a Redis outage then blocks the API.
- Cached product data can be stale for up to the TTL if an invalidation is lost (e.g. Redis briefly unreachable during a write).
- Duplicate maintenance runs during a Redis outage add some load.
- An in-process single-flight only deduplicates within one replica; the Redis lock covers replicas only while Redis is up.

## Alternatives considered

| Option                                        | Why not chosen                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Redis with AOF persistence as a durable store | Adds durability tuning and backups for data that does not need them.                               |
| In-memory caches/limits per process           | Not shared across replicas; limits multiply with replica count.                                    |
| PostgreSQL advisory locks for leader election | Viable; Redis was already present, and a fail-open lock is simpler than handling lost DB sessions. |
| Memcached                                     | No atomic `SET NX PX` semantics comparable to Redis for the lock and limiter use cases.            |

## Operational cost

- One small Redis instance (or a managed cache). Monitoring of availability, memory and evictions.
- Alerting should treat a Redis outage as **degraded**, not down; watch for the fail-open signals listed above.
