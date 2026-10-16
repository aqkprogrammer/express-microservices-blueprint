import { createHash } from 'node:crypto';
import { ConflictError, UnprocessableError } from '@emb/http-kit';
import type { PrismaClient } from '../generated/prisma/client.js';
import { isUniqueViolation } from '@emb/database';

export interface StoredResponse {
  status: number;
  body: unknown;
}

/**
 * Idempotency-Key handling for non-idempotent REST operations:
 *  1. Claim (scope, key) by inserting an IN_PROGRESS record (unique constraint).
 *  2. Run the operation and store its response.
 *  3. A repeat with the same key and body replays the stored response; the
 *     same key with a different body is rejected; a concurrent repeat while
 *     the first is still running gets 409 and should retry later.
 * Failed operations release the key so the client can retry.
 */
export class IdempotencyStore {
  constructor(private readonly prisma: PrismaClient) {}

  async execute(
    scope: string,
    key: string,
    requestBody: unknown,
    operation: () => Promise<StoredResponse>,
  ): Promise<StoredResponse & { replayed: boolean }> {
    const requestHash = createHash('sha256')
      .update(JSON.stringify(requestBody ?? null))
      .digest('hex');
    try {
      await this.prisma.idempotencyRecord.create({ data: { scope, key, requestHash, state: 'IN_PROGRESS' } });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.prisma.idempotencyRecord.findUnique({
        where: { scope_key: { scope, key } },
      });
      if (!existing) throw new ConflictError('Idempotency key state changed; retry', 'idempotency_conflict');
      if (existing.requestHash !== requestHash) {
        throw new UnprocessableError(
          'This Idempotency-Key was already used with a different request body',
          'idempotency_key_reused',
        );
      }
      if (existing.state !== 'COMPLETED' || existing.responseStatus === null) {
        throw new ConflictError(
          'A request with this Idempotency-Key is still being processed',
          'idempotency_in_progress',
        );
      }
      return { status: existing.responseStatus, body: existing.responseBody, replayed: true };
    }
    try {
      const response = await operation();
      await this.prisma.idempotencyRecord.update({
        where: { scope_key: { scope, key } },
        data: { state: 'COMPLETED', responseStatus: response.status, responseBody: response.body as object },
      });
      return { ...response, replayed: false };
    } catch (error) {
      await this.prisma.idempotencyRecord
        .delete({ where: { scope_key: { scope, key } } })
        .catch(() => undefined);
      throw error;
    }
  }

  /** Keys only need to outlive client retry windows. */
  async deleteOlderThan(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.idempotencyRecord.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return count;
  }
}
