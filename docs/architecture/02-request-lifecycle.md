# 2. Request lifecycle

[← System overview](01-system-overview.md) · [Index](README.md) · Next: [RabbitMQ event flow →](03-rabbitmq-event-flow.md)

A public request passes the gateway's edge concerns, is proxied to exactly one upstream service and
runs through the shared middleware chain from `@emb/http-kit`
([`packages/http-kit/src/app.ts`](../../packages/http-kit/src/app.ts)). The example is
`POST /api/v1/orders`.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant G as api-gateway :8080
    participant R as Redis
    participant O as order-service
    participant A as auth-service (JWKS)
    participant P as product-service
    participant DB as orders_db

    C->>G: POST /api/v1/orders + Bearer token + Idempotency-Key
    Note over G: helmet · CORS · normalise path (reject .. and encoded separators)<br/>x-request-id / x-correlation-id (reuse safe client IDs or generate)<br/>OTel server span starts (client traceparent is not forwarded)
    G->>R: rate-limit counter: 300/min/IP global, 20/min/IP on auth routes
    alt limit exceeded
        G-->>C: 429 application/problem+json
    else Redis unavailable
        Note over G,R: fail-open — availability wins over rate limiting
    end
    G->>O: streaming fetch proxy · x-request-id · x-correlation-id · traceparent<br/>x-internal-token stripped · 256 kb body limit · 10 s timeout
    Note over G,O: per-upstream circuit breaker: 5 failures → open for 10 s
    O->>A: GET /.well-known/jwks.json (cached, refetched only on unknown kid)
    Note over O: verify ES256 access token: iss, aud, exp, typ at+jwt, required claims
    O->>DB: Idempotency-Key lookup (customer + key + request fingerprint)
    O->>P: GET /internal/v1/products?ids= (x-internal-token, 2 s timeout, retries, breaker)
    P-->>O: price snapshot
    O->>DB: one transaction: order PENDING + saga + OrderCreated outbox row
    O-->>G: 201 Created (or 200 + Idempotent-Replayed: true)
    G-->>C: response + X-Request-Id + X-Correlation-Id

    opt upstream failure
        G-->>C: 502 upstream_unreachable / 503 circuit open / 504 upstream_timeout (problem+json)
    end
```

![Animated request lifecycle: client to api-gateway, Redis rate limit, proxy to order-service, JWKS verification, product price lookup, transactional write and response](../assets/animated/request-lifecycle.svg)

_Animated preview (CSS animation; it pauses into a static view when your system prefers reduced
motion). The Mermaid diagram above is the static, accessible alternative._

## What happens where

| Concern         | Where                                           | Behaviour                                                                                                                                      |
| --------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Path safety     | gateway `normalizePath`                         | Rejects `..`, `.` and encoded separators (`%2e`, `%2f`, `%5c`) with 400 before matching a route.                                               |
| Routing         | gateway `ROUTES`                                | Whole-segment prefix match; unknown paths → 404. Internal, metrics, health and admin paths are never routed.                                   |
| Rate limiting   | gateway + Redis                                 | `express-rate-limit` with a Redis store; `passOnStoreError` makes it fail open.                                                                |
| Request IDs     | `requestContextMiddleware`                      | Accepts caller IDs matching `^[A-Za-z0-9._:-]{1,128}$`, otherwise generates a UUID; echoed as response headers and attached to every log line. |
| Tracing         | OTel http/express/undici instrumentation        | The gateway strips inbound `traceparent`/`tracestate`; the fetch instrumentation injects the gateway's own context into the upstream call.     |
| Timeouts        | gateway `UpstreamProxy`                         | 10 s per upstream call; no automatic retries at the edge (non-idempotent requests must never be replayed by infrastructure).                   |
| Circuit breaker | gateway (per upstream) and service HTTP clients | Upstream 502/503/504 responses count as failures but are still relayed.                                                                        |
| Authentication  | each service (`@emb/security`)                  | Local JWT verification against the JWKS; a JWKS outage fails closed with 503.                                                                  |
| Errors          | `errorHandler`                                  | Every error is an RFC 9457 `application/problem+json` document; 5xx details are not exposed.                                                   |
