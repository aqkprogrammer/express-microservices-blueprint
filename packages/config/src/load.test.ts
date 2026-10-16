import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError, loadConfig, readSecret } from './load.js';
import { baseEnvSchema, booleanFromString, commaSeparatedList } from './schemas.js';

describe('loadConfig', () => {
  it('parses and applies defaults', () => {
    const config = loadConfig(baseEnvSchema, { SERVICE_NAME: 'svc', PORT: '3000' });
    expect(config.PORT).toBe(3000);
    expect(config.NODE_ENV).toBe('development');
    expect(config.METRICS_ENABLED).toBe(true);
  });

  it('reports every invalid variable without echoing values', () => {
    const schema = z.object({ SECRET: z.string().min(32), PORT: z.coerce.number().int() });
    try {
      loadConfig(schema, { SECRET: 'too-short-secret-value', PORT: 'abc' });
      expect.fail('expected ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain('SECRET');
      expect(message).toContain('PORT');
      expect(message).not.toContain('too-short-secret-value');
    }
  });

  it('resolves *_FILE secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    const file = join(dir, 'secret');
    writeFileSync(file, 'from-file\n');
    const schema = z.object({ DB_PASSWORD: z.string() });
    expect(loadConfig(schema, { DB_PASSWORD_FILE: file }).DB_PASSWORD).toBe('from-file');
    expect(readSecret('DB_PASSWORD', { DB_PASSWORD_FILE: file })).toBe('from-file');
    expect(loadConfig(schema, { DB_PASSWORD: 'explicit', DB_PASSWORD_FILE: file }).DB_PASSWORD).toBe(
      'explicit',
    );
    // Unrelated *_FILE variables (not declared in the schema) are ignored.
    expect(() => loadConfig(schema, { DB_PASSWORD: 'x', SOME_TOOL_FILE: '/does/not/exist' })).not.toThrow();
  });

  it('parses booleans and lists', () => {
    const schema = z.object({ FLAG: booleanFromString(false), LIST: commaSeparatedList(['a']) });
    expect(loadConfig(schema, { FLAG: 'TRUE', LIST: ' x, y ,,' })).toEqual({ FLAG: true, LIST: ['x', 'y'] });
    expect(loadConfig(schema, {})).toEqual({ FLAG: false, LIST: ['a'] });
  });
});
