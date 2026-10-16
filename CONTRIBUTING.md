# Contributing

Thanks for your interest in improving the blueprint! It aims to stay a
_working_, honest reference: every documented feature exists and is tested.

## Ground rules

- Be respectful — see the [Code of Conduct](CODE_OF_CONDUCT.md).
- Report security issues privately — see [SECURITY.md](SECURITY.md).
- Prefer essential complexity. A new tool or service has to earn its place;
  explain the trade-off (and add an ADR in `docs/decisions/` for architectural changes).
- Never commit secrets, `.env` files, keys, database dumps or personal data.

## Getting set up

```bash
nvm use                 # Node.js version from .nvmrc
npm ci
npm run build           # generates Prisma clients and compiles all workspaces
npm test                # unit + contract tests
docker compose up --build -d --wait
npm run test:e2e        # against the running stack
```

See [docs/development/getting-started.md](docs/development/getting-started.md)
and [docs/development/testing.md](docs/development/testing.md) for details,
including running a single service from source with `npm run dev -- <service>`.

## Making a change

1. Fork and create a branch from `main`.
2. Keep changes focused; add or update tests at the right level (unit,
   integration, contract, e2e, resilience).
3. Run the checks CI runs:
   ```bash
   npm run format:check && npm run lint && npm run typecheck
   npm test && npm run test:integration
   npm run docs:validate
   ```
4. Update documentation, diagrams (`npm run diagrams:build`) and the
   [CHANGELOG](CHANGELOG.md) (`Unreleased` section).
5. Open a pull request using the template.

## Conventions

- **Events** are versioned (`OrderCreated.v1`). Within a version only additive,
  optional changes are allowed; anything else requires `.v2` published in
  parallel. Update `tests/contract/fixtures/events.v1.json` only for additions.
- **Migrations** are append-only: add a new migration, never edit an applied one.
- **Messaging topology** lives in `packages/contracts/src/topology.ts`; regenerate
  the definitions with `npm run topology:generate`.
- **Commits** use clear, imperative subjects (e.g. "Add reservation expiry metric").
