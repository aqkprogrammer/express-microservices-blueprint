/**
 * The subset of a Prisma client (or interactive-transaction client) that the
 * shared helpers need. Each service has its own generated Prisma client, so
 * helpers depend on this structural type instead of any concrete client. All
 * SQL passed through it is a constant string with positional parameters.
 */
export interface SqlExecutor {
  $executeRawUnsafe(query: string, ...values: unknown[]): PromiseLike<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): PromiseLike<T>;
}
