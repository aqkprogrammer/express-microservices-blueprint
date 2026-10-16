import { roleSchema } from '@emb/contracts';
import { z } from 'zod';
import { passwordSchema } from '../domain/passwords.js';

export const registerSchema = z
  .object({
    email: z.email().max(254),
    password: passwordSchema,
    displayName: z.string().trim().min(1).max(100),
  })
  .meta({ id: 'RegisterRequest' });

export const loginSchema = z
  .object({ email: z.email().max(254), password: z.string().min(1).max(128) })
  .meta({ id: 'LoginRequest' });

/** Browsers send the refresh token as an HttpOnly cookie; other clients may send it in the body. */
export const refreshSchema = z
  .object({ refreshToken: z.string().min(20).max(200).optional() })
  .meta({ id: 'RefreshRequest' });

export const passwordResetRequestSchema = z
  .object({ email: z.email().max(254) })
  .meta({ id: 'PasswordResetRequest' });
export const passwordResetConfirmSchema = z
  .object({ token: z.string().min(20).max(200), newPassword: passwordSchema })
  .meta({ id: 'PasswordResetConfirmRequest' });

export const tokenPairSchema = z
  .object({
    accessToken: z.string(),
    tokenType: z.literal('Bearer'),
    expiresIn: z.number().int(),
    refreshToken: z.string(),
    refreshTokenExpiresAt: z.string(),
    user: z.object({ id: z.uuid(), email: z.email(), roles: z.array(roleSchema) }),
  })
  .meta({ id: 'TokenPair' });

export const meSchema = z
  .object({ userId: z.uuid(), roles: z.array(roleSchema), sessionId: z.uuid() })
  .meta({ id: 'CurrentUser' });
