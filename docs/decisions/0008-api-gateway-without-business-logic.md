# ADR-0008: API gateway without business logic

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

Clients need one origin for the public API. Edge concerns — routing, rate limiting, request IDs, CORS, body limits, path hygiene, hiding internal endpoints — should be enforced once rather than in every service. At the same time, a gateway that aggregates or transforms business data becomes a coupling point that must change whenever any service changes.

## Decision

`apps/api-gateway` is a **thin edge service with no business logic and no database**. It is implemented as a small streaming reverse proxy over Node's `fetch` (`apps/api-gateway/src/proxy.ts`) rather than an off-the-shelf proxy.

What it does:

- **Explicit route table** (`apps/api-gateway/src/routes.ts`): prefix matching on whole segments. Anything not listed — every service's `/internal/*`, `/admin/*`, `/metrics` and `/health/*` — is unreachable through the gateway.
- **Path normalisation before matching**: rejects encoded separators (`%2e`, `%2f`, `%5c`, `\`) and `.`/`..` segments with `400 invalid_path`, collapses duplicate slashes, and verifies the resolved upstream URL keeps the upstream's origin.
- **Header hygiene**: strips hop-by-hop headers, client-supplied `x-forwarded-*`, `forwarded`, `traceparent`/`tracestate` and **`x-internal-token`**; sets `x-request-id`, `x-correlation-id` and fresh `x-forwarded-*` headers; never forwards upstream `x-powered-by`.
- **Rate limits** (Redis-backed, see [ADR-0007](0007-redis-not-system-of-record.md)), **body limit** 256 kB (bodies are buffered only for non-GET/HEAD requests), `helmet` headers and a CORS allow-list.
- **Per-upstream circuit breaker** (opens after 5 consecutive failures for 10 s) and **upstream timeout** (10 s). Upstream 502/503/504 responses count as failures but are still relayed. Requests are **never retried** by the gateway: non-idempotent requests must not be replayed by infrastructure.
- **Response streaming**: upstream bodies are piped to the client; `Set-Cookie` headers are preserved individually.
- **Aggregated Swagger UI** at `/docs`, fetching each service's `/openapi.json` internally (cached 60 s).
- Metrics on a separate internal port (9464); the public port never serves `/metrics`.

What it deliberately does not do: authentication decisions (services verify JWTs themselves), response aggregation, request transformation, or caching.

## Consequences

### Positive

- Services stay the only place where business rules and authorization live. Removing or replacing the gateway does not change domain behaviour.
- The whole edge policy is roughly 500 lines of TypeScript (`apps/api-gateway/src`) that the rest of the team can read, test (`apps/api-gateway/src/*.test.ts`) and instrument with the same logging, metrics and tracing as the services.
- Internal endpoints are protected twice: not routable at the edge, and guarded by `x-internal-token` inside the network.

### Negative and trade-offs

- A custom proxy is code to maintain and secure. Mature proxies have years of hardening against HTTP edge cases (request smuggling, slow clients, HTTP/2 and WebSocket handling). This gateway supports HTTP/1.1 request/response traffic only; it has no WebSocket support.
- Request bodies are buffered (up to the limit) before forwarding, not streamed upstream.
- Each service verifies tokens independently (JWKS fetched and cached per service), which is more work than verifying once at the edge — but avoids services trusting a header set by the gateway.
- Features such as TLS termination, HTTP/2, WAF rules, canary routing and global rate limiting at very high volume are not provided; in production a load balancer or ingress in front of the gateway typically supplies TLS and HTTP/2.

## Alternatives considered

| Option                                | Trade-off                                                                                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Nginx**                             | Battle-tested, very fast, low memory. Configuration is a separate language; Redis-backed limits, OTel context and problem-details errors need modules or Lua. A good replacement if the custom proxy becomes a liability. |
| **Kong**                              | Rich plugin ecosystem (auth, limits, transformations) and an admin API; adds a database or declarative config and its own operational model.                                                                              |
| **Envoy**                             | Excellent observability, retries, circuit breaking and HTTP/2/gRPC; configuration is verbose and usually managed through a control plane or service mesh.                                                                 |
| Cloud API gateways                    | Managed, but not runnable offline for local development, and vendor-specific.                                                                                                                                             |
| Backend-for-frontend with aggregation | Useful for specific clients; would add business logic to the edge, which this blueprint avoids.                                                                                                                           |

## Operational cost

- One stateless Node.js service, horizontally scalable; depends on Redis for shared limits (fail-open).
- Must be kept patched like any edge component; the route table must be updated when a public endpoint is added (see [adding a service](../development/adding-a-service.md)).
- `TRUST_PROXY` must match the real proxy chain in front of the gateway, otherwise rate limiting keys on the wrong client IP.
