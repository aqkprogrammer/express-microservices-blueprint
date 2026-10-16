import { createHash, timingSafeEqual } from 'node:crypto';

/** Compares secrets without leaking length or prefix matches through timing. */
export function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}
