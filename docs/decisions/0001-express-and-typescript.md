# ADR-0001: Express.js and TypeScript for every service

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

The blueprint must be readable by the widest possible audience of Node.js developers and must show production concerns (validation, error handling, security headers, observability, graceful shutdown) without hiding them behind framework magic. Services share contracts — event payloads, problem documents, configuration schemas — so those contracts must be type-checked at compile time _and_ validated at runtime, because data crosses process boundaries.

## Decision

- Every service is an **Express 5** application written in **TypeScript** (strict mode, `noUncheckedIndexedAccess`, ES modules with `NodeNext` resolution) running on **Node.js 22.13+ / 24** (`.nvmrc` pins 24).
- Runtime validation uses **Zod 4**. The same schemas validate requests (`parseWith` in `packages/http-kit`), configuration (`packages/config`), and event payloads (`packages/contracts`), and generate the OpenAPI documents.
- Cross-cutting middleware is assembled once in `createServiceApp` (`packages/http-kit/src/app.ts`) in a fixed order: `helmet` → CORS allow-list → request context → metrics/access log → health/metrics/docs endpoints → JSON body parser with size limit → routes → 404 → RFC 9457 error handler. Services only add routes.
- Express 5 forwards rejected promises from async handlers to the error handler, so handlers simply `throw` typed `AppError`s.

## Consequences

### Positive

- Express is the most widely understood Node.js HTTP framework; the code reads as plain functions and middleware.
- Shared Zod schemas give one source of truth for types, runtime validation and API documentation.
- The fixed middleware order in one place makes security-relevant ordering (e.g. body limits before routes) reviewable.

### Negative and trade-offs

- Express has no built-in schema validation or serialization; the blueprint adds Zod and its own error mapping.
- Middleware ordering is a convention enforced by `createServiceApp`, not by the framework. A service that bypasses it loses those guarantees.
- Express's raw request throughput is lower than some alternatives (e.g. Fastify). No benchmark was run for this repository; for I/O-bound services that talk to PostgreSQL and RabbitMQ the framework is rarely the bottleneck, but this should be measured for a specific workload rather than assumed.
- TypeScript adds a build step (`tsc -b`) and project references to maintain.

## Alternatives considered

| Option           | Why not chosen                                                                                                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fastify          | Strong choice (schema-first, fast, good plugin model). Not chosen because Express is more familiar to the target audience and the patterns shown here transfer directly. Migrating is straightforward because domain code does not depend on Express types. |
| NestJS           | Adds DI containers, decorators and module conventions that obscure the mechanisms this blueprint wants to show explicitly.                                                                                                                                  |
| Hono / Koa       | Smaller ecosystems for the instrumentation and middleware used here.                                                                                                                                                                                        |
| Plain JavaScript | Loses compile-time checking of shared contracts across ten deployable applications.                                                                                                                                                                         |
| Go / JVM         | Out of scope: the blueprint targets Node.js teams.                                                                                                                                                                                                          |

## Operational cost

- One Node.js process per service container (Compose limits each to 256 MB; auth-service 384 MB for Argon2id).
- Node.js and dependency upgrades must be applied across all workspaces together (see [ADR-0002](0002-npm-workspaces-monorepo.md)).
- Engineers need TypeScript and Zod familiarity; both are mainstream.
