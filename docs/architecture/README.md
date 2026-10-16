# Architecture diagrams

Twelve diagrams that describe how the Express Microservices Blueprint actually works. Each page has
a **static Mermaid diagram** (rendered natively by GitHub, text-based and accessible) plus a short
explanation; seven flows also have an **animated SVG preview**.

![Static system overview of the Express Microservices Blueprint](../assets/animated/system-overview.svg)

_Static overview image (no animation). See [page 1](01-system-overview.md) for the Mermaid version._

## Index

| #   | Diagram                                               | What it shows                                                                                                                                                                       | Animated preview                                                                                                                                   |
| --- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [System overview](01-system-overview.md)              | Gateway, eight services, worker, PostgreSQL, RabbitMQ, Redis, Mailpit and the observability stack.                                                                                  | static image only                                                                                                                                  |
| 2   | [Request lifecycle](02-request-lifecycle.md)          | Client → gateway → service: path safety, Redis rate limit, request/correlation IDs, trace propagation, timeouts and circuit breaker, JWKS verification, `application/problem+json`. | [request-lifecycle.svg](../assets/animated/request-lifecycle.svg)                                                                                  |
| 3   | [RabbitMQ event flow](03-rabbitmq-event-flow.md)      | Exchanges `domain.events`, `maintenance.commands`, `dead-letters`; every per-service quorum queue and its real binding keys; retry tiers.                                           | —                                                                                                                                                  |
| 4   | [Order saga](04-order-saga.md)                        | Orchestrated saga with compensations, order/saga states, timeouts and payment reconciliation.                                                                                       | [order-saga-success.svg](../assets/animated/order-saga-success.svg), [order-saga-compensation.svg](../assets/animated/order-saga-compensation.svg) |
| 5   | [Transactional outbox](05-transactional-outbox.md)    | Atomic state + event write, `FOR UPDATE SKIP LOCKED` claiming with leases, publisher confirms, idempotent consumers.                                                                | [transactional-outbox.svg](../assets/animated/transactional-outbox.svg)                                                                            |
| 6   | [Retry and dead-letter flow](06-retry-dead-letter.md) | Retry tiers (1 s / 5 s / 15 s), poison messages, delivery limit, worker archive, replay and discard.                                                                                | [retry-dead-letter.svg](../assets/animated/retry-dead-letter.svg)                                                                                  |
| 7   | [Authentication](07-authentication.md)                | Register, login and lockout, refresh rotation with reuse detection, logout, password reset, JWKS verification in services.                                                          | [auth-refresh-rotation.svg](../assets/animated/auth-refresh-rotation.svg)                                                                          |
| 8   | [Observability and tracing](08-observability.md)      | OTel SDK → Jaeger and Loki, Prometheus scrapes and alerts, Grafana; trace context through outbox rows and AMQP headers.                                                             | —                                                                                                                                                  |
| 9   | [Docker Compose deployment](09-docker-compose.md)     | Containers, ports published on 127.0.0.1, volumes, one-shot `keygen` and `migrator`, startup order.                                                                                 | —                                                                                                                                                  |
| 10  | [Kubernetes (optional)](10-kubernetes.md)             | Optional Kustomize manifests: Ingress to the gateway only, Deployments, NetworkPolicies, HPA, PDB, migration Job, managed data services.                                            | —                                                                                                                                                  |
| 11  | [CI/CD pipeline](11-ci-cd.md)                         | Quality gates → integration (Testcontainers) → images → Trivy → e2e; CodeQL, gitleaks, npm audit, Dependabot; tag releases.                                                         | —                                                                                                                                                  |
| 12  | [Failure recovery](12-failure-recovery.md)            | Broker outage, database outage, payment timeout reconciliation, process crash.                                                                                                      | [failure-recovery.svg](../assets/animated/failure-recovery.svg)                                                                                    |

## Reading the animated previews

- The animated SVGs use **only CSS `@keyframes`** — no JavaScript, fonts, images or remote
  resources — so they render on GitHub, which displays SVG through `<img>`.
- Each flow loops every 13–14 s: the arrow for each step draws in order, a dot travels along it,
  its label fades in and the current row is highlighted. Arrow colours: blue = request,
  green = response / success, purple = event via RabbitMQ, red = failure, orange = compensation or
  recovery.
- If your system asks for **reduced motion** (`prefers-reduced-motion: reduce`), the animation is
  disabled and every step is shown at once.
- Every SVG has a `<title>` and `<desc>`. The Mermaid diagram on the corresponding page is the
  static, accessible alternative and the reference if the two ever disagree.

## Regenerating diagrams

**Mermaid diagrams** are plain text in the pages above; edit them directly. GitHub renders
` ```mermaid ` blocks natively, and the [Mermaid Live Editor](https://mermaid.live) is handy for
previewing larger changes. The diagrams intentionally stick to `flowchart`, `sequenceDiagram` and
`stateDiagram-v2` with quoted labels so they render on GitHub's Mermaid version.

**Animated SVGs** are generated — do not edit the files in `docs/assets/animated/` by hand:

```bash
npm run diagrams:build
# equivalent to: node scripts/diagrams/build-animated-svgs.mjs   (Node 22+, no dependencies)
```

The script [`scripts/diagrams/build-animated-svgs.mjs`](../../scripts/diagrams/build-animated-svgs.mjs)
declares each flow as data — lanes (nodes) with positions and labels, then ordered steps of
labelled edges or notes — and renders self-contained SVGs. It fails if an SVG contains `<script>`,
references a remote resource or exceeds 60 KB. To change a flow:

1. Update the flow declaration in the script (`FLOWS` for animated sequences, `OVERVIEW` for the
   static hero image).
2. Update the matching Mermaid diagram so both stay in sync with the code.
3. Run `npm run diagrams:build` and commit the regenerated files in `docs/assets/animated/`.
4. Check the result in a browser (animated) and with reduced motion enabled (static view).

When the implementation changes — a new event, queue, binding or saga step — the source of truth is
the code ([`packages/contracts/src/topology.ts`](../../packages/contracts/src/topology.ts),
[`packages/contracts/src/events.ts`](../../packages/contracts/src/events.ts), `apps/*`); update the
affected diagrams in the same pull request.
