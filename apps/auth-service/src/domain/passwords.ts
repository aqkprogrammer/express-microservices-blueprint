import argon2 from 'argon2';
import { z } from 'zod';

/**
 * Argon2id with the OWASP-recommended minimum (19 MiB memory, 2 iterations,
 * 1 lane). Tune upward for production hardware; old hashes keep verifying
 * because parameters are stored in the PHC string, and `needsRehash` lets
 * login upgrade them transparently.
 */
const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters');

export const hashPassword = (password: string) => argon2.hash(password, OPTIONS);

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export const needsRehash = (hash: string) => argon2.needsRehash(hash, OPTIONS);

/**
 * Verifying against a fixed hash when the account does not exist keeps login
 * timing similar for known and unknown emails (limits account enumeration).
 */
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing-equalisation');
  await verifyPassword(await dummyHash, password);
}
