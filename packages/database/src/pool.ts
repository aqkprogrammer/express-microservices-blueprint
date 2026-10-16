import { gauge } from '@emb/observability';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

export interface PgPoolOptions {
  connectionString: string;
  /** Logical name for metrics (usually the service name). */
  name: string;
  max?: number;
  statementTimeoutMs?: number;
  connectionTimeoutMs?: number;
  idleTimeoutMs?: number;
}

const pools = new Map<string, pg.Pool>();

gauge('db_pool_connections', 'PostgreSQL pool connections by state', ['pool', 'state'], function collect() {
  for (const [name, pool] of pools) {
    this.set({ pool: name, state: 'total' }, pool.totalCount);
    this.set({ pool: name, state: 'idle' }, pool.idleCount);
    this.set({ pool: name, state: 'waiting' }, pool.waitingCount);
  }
});
const poolMax = gauge('db_pool_max_connections', 'Configured pool size', ['pool']);

/**
 * Creates a bounded pg pool. A statement timeout protects the service from
 * runaway queries, and the gauges above make pool exhaustion visible.
 */
export function createPgPool(options: PgPoolOptions): pg.Pool {
  const max = options.max ?? 10;
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max,
    application_name: options.name,
    statement_timeout: options.statementTimeoutMs ?? 10_000,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
  });
  // Idle client errors (e.g. server restart) must not crash the process; the pool replaces the client.
  pool.on('error', () => undefined);
  pools.set(options.name, pool);
  poolMax.set({ pool: options.name }, max);
  return pool;
}

export function createPrismaAdapter(pool: pg.Pool): PrismaPg {
  return new PrismaPg(pool);
}
