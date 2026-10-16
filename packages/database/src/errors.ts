import type { SqlExecutor } from './sql.js';

/** True for unique-constraint violations from Prisma (P2002) or raw pg (23505). */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'P2002' || code === '23505') return true;
  const meta = (
    error as { meta?: { driverAdapterError?: { cause?: { kind?: string; originalCode?: string } } } }
  ).meta;
  const cause = meta?.driverAdapterError?.cause;
  return cause?.kind === 'UniqueConstraintViolation' || cause?.originalCode === '23505';
}

export function databaseHealthCheck(db: SqlExecutor) {
  return {
    name: 'postgres',
    critical: true,
    check: async () => {
      await db.$queryRawUnsafe('SELECT 1');
    },
  };
}
