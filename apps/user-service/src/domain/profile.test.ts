import { describe, expect, it } from 'vitest';
import { updateProfileSchema, validateStatusChange } from './profile.js';

describe('account status rules', () => {
  it('allows suspending and reactivating other accounts', () => {
    expect(validateStatusChange('active', 'suspended', 'admin', 'user')).toBeUndefined();
    expect(validateStatusChange('suspended', 'active', 'admin', 'user')).toBeUndefined();
  });

  it('rejects self-changes, no-ops and reopening closed accounts', () => {
    expect(validateStatusChange('active', 'suspended', 'same', 'same')).toMatch(/own account/);
    expect(validateStatusChange('active', 'active', 'admin', 'user')).toMatch(/already/);
    expect(validateStatusChange('closed', 'active', 'admin', 'user')).toMatch(/cannot be reopened/);
  });
});

describe('profile update validation', () => {
  it('requires at least one field and validates locale', () => {
    expect(updateProfileSchema.safeParse({}).success).toBe(false);
    expect(updateProfileSchema.safeParse({ locale: 'english' }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ locale: 'en-GB' }).success).toBe(true);
  });

  it('does not accept privileged fields', () => {
    const parsed = updateProfileSchema.parse({ displayName: 'Ada', roles: ['admin'], status: 'active' });
    expect(parsed).toEqual({ displayName: 'Ada' });
  });
});
