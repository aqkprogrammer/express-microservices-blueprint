import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createPgPool, createPrismaAdapter } from '@emb/database';
import { createLogger } from '@emb/logger';
import { migrateServiceDatabase, type StartedDependency } from '@emb/testing';
import pg from 'pg';

export const repoRoot = join(import.meta.dirname, '../..');
export const silentLogger = createLogger({
  service: 'integration-test',
  level: process.env.TEST_LOG_LEVEL ?? 'silent',
});

/** Creates a fresh database inside the shared Postgres container and applies a service's migrations. */
export async function createServiceDatabase(postgres: StartedDependency, service: string): Promise<string> {
  const name = `${service.replaceAll('-', '_')}_${randomUUID().slice(0, 8)}`;
  const admin = new pg.Client({ connectionString: postgres.url });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const url = new URL(postgres.url);
  url.pathname = `/${name}`;
  migrateServiceDatabase(join(repoRoot, 'apps', service), url.toString());
  return url.toString();
}

/** Builds a Prisma client for a service using its own generated client class. */
export function prismaFor<T>(
  PrismaClient: new (options: { adapter: ReturnType<typeof createPrismaAdapter> }) => T,
  url: string,
  name: string,
) {
  const pool = createPgPool({ connectionString: url, name, max: 20 });
  const client = new PrismaClient({ adapter: createPrismaAdapter(pool) });
  return { client, close: () => pool.end() };
}
