# ADR-0002: npm-workspaces monorepo

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

Ten deployable applications (`apps/*`: the API gateway, eight domain services and the worker) share infrastructure code (`packages/*`): configuration loading, the event catalog and topology, the outbox and idempotency helpers, HTTP kit, logging, observability and security. Contract changes (for example a new event field) must be checked against every producer and consumer in one change. The repository should work with tooling every Node.js developer already has.

## Decision

- One Git repository using **npm workspaces** (`"workspaces": ["packages/*", "apps/*"]`). Internal packages are named `@emb/<name>` and are never published to a registry.
- TypeScript **project references** (`tsconfig.build.json`) build packages before apps; `npm run build` runs `prisma generate` for every service and then `tsc -b`.
- Packages export a `source` condition pointing at `src/*.ts`, so `tsx` (development) and Vitest run against sources without a build, while production images use compiled `dist/`.
- One lockfile (`package-lock.json`) pins the whole dependency graph.
- Docker images are built from the repository root with one multi-stage Dockerfile; the production-dependency stage installs only the target workspace (`npm ci --omit=dev --workspace apps/<service>`).

## Consequences

### Positive

- Atomic changes across contracts, producers and consumers; contract tests (`tests/contract`) run against all of them.
- No extra build orchestrator to learn.
- Shared lint, format, test and TypeScript configuration.

### Negative and trade-offs

- npm workspaces have no task graph or remote caching. Every CI run builds all workspaces; there is no "only build what changed" logic. Turborepo or Nx could add this later.
- All services move to a new version of a shared dependency at once. This is intentional (one tested combination) but makes staggered upgrades harder.
- Independent per-service versioning and release cadence need extra tooling (image tags per service) — the code is shared, the deployables are not.
- A monorepo makes it easy to import across service boundaries by accident; the rule is that `apps/*` may import `packages/*` but never another app.

## Alternatives considered

| Option                                | Why not chosen                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Polyrepo (one repository per service) | Contract changes would span many pull requests and need a published contracts package with its own versioning.           |
| pnpm workspaces                       | Faster installs and stricter dependency isolation; not chosen to avoid an extra tool requirement. Switching is low-risk. |
| Nx / Turborepo                        | Useful at larger scale for affected-only builds and caching; unnecessary complexity for ten applications.                |

## Operational cost

- CI time grows with the number of workspaces because everything is built and tested on each run.
- One `npm ci` installs dependencies for every workspace locally (several hundred packages in `node_modules`).
- Requires npm 10+ and Node.js 22.13+.
