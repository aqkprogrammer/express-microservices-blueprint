#!/usr/bin/env node
// Runs a k6 scenario in Docker against the Compose stack's gateway.
//
//   npm run test:load                      # catalog-browse.js
//   npm run test:load -- order-placement.js
//   DURATION=1m RATE=100 npm run test:load
//
// The gateway rate-limits per client IP, and every k6 request comes from one
// IP. Raise the limits for the duration of a load test, e.g.:
//   RATE_LIMIT_MAX=1000000 AUTH_RATE_LIMIT_MAX=1000 docker compose up -d api-gateway
// Results depend entirely on the machine; do not compare numbers across hosts.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const script = process.argv[2] ?? 'catalog-browse.js';
const network = process.env.COMPOSE_NETWORK ?? 'emb_default';
const results = resolve('tests/load/results');
mkdirSync(results, { recursive: true });
const passthrough = ['DURATION', 'RATE', 'VUS', 'CUSTOMERS'].flatMap((name) =>
  process.env[name] ? ['-e', `${name}=${process.env[name]}`] : [],
);
const result = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '--network',
    network,
    '--user',
    `${process.getuid?.() ?? 1000}`,
    '-v',
    `${resolve('tests/load')}:/scripts:ro`,
    '-v',
    `${results}:/results`,
    '-e',
    `BASE_URL=${process.env.LOAD_BASE_URL ?? 'http://api-gateway:8080'}`,
    ...passthrough,
    'grafana/k6:1.2.0',
    'run',
    `/scripts/${script}`,
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
