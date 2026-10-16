import { roleSchema } from '@emb/contracts';
import { paginationQuerySchema } from '@emb/http-kit';
import { z } from 'zod';

export const ACCOUNT_STATUSES = ['active', 'suspended', 'closed'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/**
 * Account status rules: suspension is reversible, closure is final.
 * Returns an error message when the change is not allowed.
 */
export function validateStatusChange(
  from: AccountStatus,
  to: AccountStatus,
  actorId: string,
  targetId: string,
): string | undefined {
  if (actorId === targetId) return 'Administrators cannot change their own account status';
  if (from === to) return `Account is already ${to}`;
  if (from === 'closed') return 'Closed accounts cannot be reopened';
  return undefined;
}

export const profileSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
    displayName: z.string(),
    roles: z.array(roleSchema),
    status: z.enum(ACCOUNT_STATUSES),
    locale: z.string(),
    marketingOptIn: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'UserProfile' });
export type ProfileDto = z.infer<typeof profileSchema>;

/** Admin view adds operational fields that are not shown to the user themself. */
export const adminProfileSchema = profileSchema
  .extend({ statusReason: z.string().nullable(), version: z.number().int() })
  .meta({ id: 'AdminUserProfile' });

export const updateProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100).optional(),
    locale: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
      .optional(),
    marketingOptIn: z.boolean().optional(),
  })
  .refine(
    (body) => Object.values(body).some((value) => value !== undefined),
    'At least one field must be provided',
  )
  .meta({ id: 'UpdateProfileRequest' });

export const changeStatusSchema = z
  .object({ status: z.enum(ACCOUNT_STATUSES), reason: z.string().trim().min(3).max(500) })
  .meta({ id: 'ChangeAccountStatusRequest' });

export const listUsersQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().min(2).max(100).optional(),
  status: z.enum(ACCOUNT_STATUSES).optional(),
  sort: z.enum(['newest', 'oldest', 'email']).default('newest'),
});

export const userIdParams = z.object({ userId: z.uuid() });
