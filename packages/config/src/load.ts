import { readFileSync } from 'node:fs';
import type { z } from 'zod';

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Resolves `<NAME>_FILE` indirection used by Docker/Kubernetes secrets: when
 * `<NAME>_FILE` is set, the file contents replace `<NAME>`. Explicit values win.
 * Only variables declared in the schema are considered, so unrelated `*_FILE`
 * variables in the environment are ignored.
 */
function resolveFileSecrets(
  source: NodeJS.ProcessEnv,
  declaredKeys: string[],
): Record<string, string | undefined> {
  const resolved: Record<string, string | undefined> = { ...source };
  for (const target of declaredKeys) {
    const file = source[`${target}_FILE`];
    if (!file) continue;
    if (resolved[target] !== undefined && resolved[target] !== '') continue;
    resolved[target] = readFileSync(file, 'utf8').trim();
  }
  return resolved;
}

function declaredKeys(schema: z.ZodType): string[] {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  return shape ? Object.keys(shape) : [];
}

/**
 * Validates environment variables against a Zod schema. Error messages name the
 * offending variable but never echo its value, so secrets cannot leak into logs.
 */
export function loadConfig<TSchema extends z.ZodType>(
  schema: TSchema,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<TSchema> {
  const result = schema.safeParse(resolveFileSecrets(source, declaredKeys(schema)));
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

/** Reads a secret from `<name>` or the file referenced by `<name>_FILE`. */
export function readSecret(name: string, source: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = source[name];
  if (direct) return direct;
  const file = source[`${name}_FILE`];
  return file ? readFileSync(file, 'utf8').trim() : undefined;
}
