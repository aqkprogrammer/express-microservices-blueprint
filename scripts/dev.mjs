#!/usr/bin/env node
// Runs services from source with hot reload (tsx watch) against infrastructure
// started by Docker Compose.
//
//   npm run dev -- <service> [<service> ...]   e.g. npm run dev -- order-service
//   npm run dev -- all                         every service (needs ~2 GB RAM)
//   npm run dev -- --infra-only                only start the infrastructure containers
//
// Infrastructure ports are published by docker-compose.dev.yml. Values below are
// the same synthetic local defaults as docker-compose.yml.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const env = (name, fallback) => process.env[name] ?? fallback;
const db = (role, password, name) => `postgresql://${role}:${password}@localhost:5432/${name}`;
const shared = {
  NODE_ENV: 'development',
  LOG_LEVEL: env('LOG_LEVEL', 'debug'),
  RABBITMQ_URL: `amqp://${env('RABBITMQ_USER', 'emb')}:${env('RABBITMQ_PASSWORD', 'local-dev-rabbitmq-password')}@localhost:5672`,
  REDIS_URL: 'redis://localhost:6379',
  JWKS_URL: 'http://localhost:3001/.well-known/jwks.json',
  INTERNAL_API_TOKEN: env('INTERNAL_API_TOKEN', 'local-dev-internal-token-change-me-000000'),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://localhost:4318/v1/traces',
};
const SERVICES = {
  'auth-service': {
    PORT: 3001,
    DATABASE_URL: db('auth_svc', env('AUTH_DB_PASSWORD', 'local-dev-auth-db-password'), 'auth_db'),
    JWT_PRIVATE_KEY_FILE: 'secrets/jwt-private.pem',
    COOKIE_SECURE: 'false',
    ADMIN_EMAIL: env('ADMIN_EMAIL', 'admin@example.test'),
    ADMIN_BOOTSTRAP_PASSWORD: env('ADMIN_BOOTSTRAP_PASSWORD', 'local-dev-admin-password'),
  },
  'user-service': {
    PORT: 3002,
    DATABASE_URL: db('users_svc', env('USER_DB_PASSWORD', 'local-dev-user-db-password'), 'users_db'),
  },
  'product-service': {
    PORT: 3003,
    DATABASE_URL: db(
      'product_svc',
      env('PRODUCT_DB_PASSWORD', 'local-dev-product-db-password'),
      'product_db',
    ),
  },
  'inventory-service': {
    PORT: 3004,
    DATABASE_URL: db(
      'inventory_svc',
      env('INVENTORY_DB_PASSWORD', 'local-dev-inventory-db-password'),
      'inventory_db',
    ),
  },
  'order-service': {
    PORT: 3005,
    DATABASE_URL: db('orders_svc', env('ORDER_DB_PASSWORD', 'local-dev-order-db-password'), 'orders_db'),
    PRODUCT_SERVICE_URL: 'http://localhost:3003',
    PAYMENT_SERVICE_URL: 'http://localhost:3006',
  },
  'payment-service': {
    PORT: 3006,
    DATABASE_URL: db(
      'payment_svc',
      env('PAYMENT_DB_PASSWORD', 'local-dev-payment-db-password'),
      'payment_db',
    ),
  },
  'notification-service': {
    PORT: 3007,
    DATABASE_URL: db(
      'notification_svc',
      env('NOTIFICATION_DB_PASSWORD', 'local-dev-notification-db-password'),
      'notification_db',
    ),
    EMAIL_TRANSPORT: 'smtp',
    SMTP_HOST: 'localhost',
    SMTP_PORT: 1025,
  },
  'audit-service': {
    PORT: 3008,
    DATABASE_URL: db('audit_svc', env('AUDIT_DB_PASSWORD', 'local-dev-audit-db-password'), 'audit_db'),
  },
  worker: {
    PORT: 3009,
    DATABASE_URL: db('worker_svc', env('WORKER_DB_PASSWORD', 'local-dev-worker-db-password'), 'worker_db'),
  },
  'api-gateway': {
    PORT: 8080,
    METRICS_PORT: 9464,
    AUTH_SERVICE_URL: 'http://localhost:3001',
    USER_SERVICE_URL: 'http://localhost:3002',
    PRODUCT_SERVICE_URL: 'http://localhost:3003',
    INVENTORY_SERVICE_URL: 'http://localhost:3004',
    ORDER_SERVICE_URL: 'http://localhost:3005',
    PAYMENT_SERVICE_URL: 'http://localhost:3006',
    NOTIFICATION_SERVICE_URL: 'http://localhost:3007',
    AUDIT_SERVICE_URL: 'http://localhost:3008',
  },
};

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log(
    `Usage: npm run dev -- <service...> | all | --infra-only\nServices: ${Object.keys(SERVICES).join(', ')}`,
  );
  process.exit(1);
}
const compose = ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml'];
console.log(
  'Starting infrastructure (postgres, redis, rabbitmq, mailpit, jaeger) and applying migrations...',
);
const infra = spawnSync(
  'docker',
  [...compose, 'up', '-d', '--wait', 'postgres', 'redis', 'rabbitmq', 'mailpit', 'jaeger'],
  { stdio: 'inherit' },
);
if (infra.status !== 0) process.exit(infra.status ?? 1);
const migrate = spawnSync('docker', [...compose, 'run', '--rm', '--build', 'migrator'], { stdio: 'inherit' });
if (migrate.status !== 0) process.exit(migrate.status ?? 1);
if (args.includes('--infra-only')) process.exit(0);

if (!existsSync('secrets/jwt-private.pem'))
  spawnSync('node', ['scripts/generate-dev-keys.mjs'], { stdio: 'inherit' });
spawnSync('npm', ['run', 'db:generate'], { stdio: 'inherit' });

const selected = args.includes('all') ? Object.keys(SERVICES) : args;
for (const name of selected) {
  if (!SERVICES[name]) {
    console.error(`Unknown service ${name}`);
    process.exit(1);
  }
  const child = spawn(
    'npx',
    ['tsx', 'watch', '--conditions=source', '--import', './src/telemetry.ts', 'src/main.ts'],
    {
      cwd: `apps/${name}`,
      env: {
        ...process.env,
        ...shared,
        OTEL_SDK_DISABLED: env('OTEL_SDK_DISABLED', 'false'),
        ...SERVICES[name],
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const prefix = `[${name}] `;
  child.stdout.on('data', (chunk) => process.stdout.write(chunk.toString().replace(/^/gm, prefix)));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk.toString().replace(/^/gm, prefix)));
  child.on('exit', (code) => console.log(`${prefix}exited with ${code}`));
}
