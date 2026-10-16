# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-16

Initial public version of the blueprint.

### Added

- Ten Express 5 / TypeScript services: API gateway, auth, user, product,
  inventory, order (saga orchestrator), payment (local simulator), notification,
  audit and a background worker — each with its own PostgreSQL database and
  Prisma migrations.
- Shared packages for configuration, logging, observability, HTTP (problem
  details, graceful shutdown, resilient service client with circuit breaker),
  security (JWT/JWKS, RBAC), contracts (versioned event catalog and RabbitMQ
  topology), database (transactional outbox, idempotent consumers) and messaging
  (publisher confirms, retry queues, dead-lettering, outbox relay).
- Order-processing saga with persisted state, compensations, timeouts and
  payment reconciliation; overselling protection in inventory.
- Docker Compose environment with PostgreSQL, Redis, RabbitMQ, Mailpit,
  Jaeger, Loki, Prometheus (12 example alert rules) and Grafana (2 dashboards).
- Optional Kubernetes manifests (Kustomize base and overlays).
- Unit, contract, integration (Testcontainers), end-to-end, resilience and k6
  load tests; GitHub Actions for CI, security scanning and releases.
- Architecture documentation with 12 Mermaid diagrams, animated SVG flows,
  15 ADRs, runbook and security documentation.
