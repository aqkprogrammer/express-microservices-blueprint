import type { EventPayload, Role } from '@emb/contracts';
import { enqueueEvent, isUniqueViolation, markMessageProcessed } from '@emb/database';
import { ConflictError, NotFoundError, UnprocessableError, paginated } from '@emb/http-kit';
import type { Logger } from '@emb/logger';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { validateStatusChange, type AccountStatus, type ProfileDto } from './profile.js';
import type { z } from 'zod';
import type { listUsersQuerySchema, updateProfileSchema } from './profile.js';

const PRODUCER = 'user-service';
type ProfileRow = Prisma.UserProfileGetPayload<object>;
const meta = (userId: string) => ({ producer: PRODUCER, aggregateType: 'user', aggregateId: userId });

/** Output shaping: only whitelisted fields leave the service. */
export const toProfileDto = (row: ProfileRow): ProfileDto => ({
  id: row.id,
  email: row.email,
  displayName: row.displayName,
  roles: row.roles as Role[],
  status: row.status as AccountStatus,
  locale: row.locale,
  marketingOptIn: row.marketingOptIn,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toAdminDto = (row: ProfileRow) => ({
  ...toProfileDto(row),
  statusReason: row.statusReason,
  version: row.version,
});

export class UserService {
  constructor(
    private readonly deps: { prisma: PrismaClient; logger: Logger; onEventsCommitted: () => void },
  ) {}

  async createFromRegistration(messageId: string, payload: EventPayload<'UserRegistered'>): Promise<void> {
    try {
      await this.deps.prisma.$transaction(async (tx) => {
        if (!(await markMessageProcessed(tx, 'user.user-registered', messageId))) return;
        await tx.userProfile.create({
          data: {
            id: payload.userId,
            email: payload.email,
            displayName: payload.displayName,
            roles: payload.roles,
          },
        });
      });
      this.deps.logger.info({ userId: payload.userId }, 'profile created');
    } catch (error) {
      // The profile already exists (e.g. replayed from the dead-letter archive): nothing to do.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  async getProfile(userId: string): Promise<ProfileDto> {
    const row = await this.deps.prisma.userProfile.findUnique({ where: { id: userId } });
    if (!row) throw new NotFoundError('Profile not found');
    return toProfileDto(row);
  }

  async getForAdmin(userId: string) {
    const row = await this.deps.prisma.userProfile.findUnique({ where: { id: userId } });
    if (!row) throw new NotFoundError('User not found');
    return toAdminDto(row);
  }

  async updateProfile(userId: string, changes: z.output<typeof updateProfileSchema>): Promise<ProfileDto> {
    const row = await this.deps.prisma.$transaction(async (tx) => {
      const existing = await tx.userProfile.findUnique({ where: { id: userId } });
      if (!existing) throw new NotFoundError('Profile not found');
      if (existing.status !== 'active')
        throw new ConflictError('Inactive accounts cannot be edited', 'account_inactive');
      const updated = await tx.userProfile.update({
        where: { id: userId },
        data: { ...changes, version: { increment: 1 } },
      });
      if (changes.displayName !== undefined && changes.displayName !== existing.displayName) {
        await enqueueEvent(
          tx,
          'UserProfileUpdated',
          { userId, email: updated.email, displayName: updated.displayName },
          meta(userId),
        );
      }
      return updated;
    });
    this.deps.onEventsCommitted();
    return toProfileDto(row);
  }

  async changeStatus(userId: string, status: AccountStatus, reason: string, actorId: string) {
    const row = await this.deps.prisma.$transaction(async (tx) => {
      const existing = await tx.userProfile.findUnique({ where: { id: userId } });
      if (!existing) throw new NotFoundError('User not found');
      const problem = validateStatusChange(existing.status as AccountStatus, status, actorId, userId);
      if (problem) throw new UnprocessableError(problem, 'invalid_status_change');
      const updated = await tx.userProfile.update({
        where: { id: userId },
        data: { status, statusReason: reason, version: { increment: 1 } },
      });
      await enqueueEvent(
        tx,
        'UserStatusChanged',
        { userId, status, previousStatus: existing.status as AccountStatus, reason, changedBy: actorId },
        meta(userId),
      );
      return updated;
    });
    this.deps.onEventsCommitted();
    return toAdminDto(row);
  }

  async list(query: z.output<typeof listUsersQuerySchema>) {
    const where: Prisma.UserProfileWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { email: { contains: query.q, mode: 'insensitive' } },
              { displayName: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const orderBy: Prisma.UserProfileOrderByWithRelationInput[] =
      query.sort === 'email'
        ? [{ email: 'asc' }]
        : [{ createdAt: query.sort === 'oldest' ? 'asc' : 'desc' }, { id: 'asc' }];
    const [rows, total] = await this.deps.prisma.$transaction([
      this.deps.prisma.userProfile.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.deps.prisma.userProfile.count({ where }),
    ]);
    return paginated(rows.map(toAdminDto), total, query.page, query.pageSize);
  }
}
