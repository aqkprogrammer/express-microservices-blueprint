export interface SerializedError {
  type: string;
  message: string;
  code?: string;
  stack?: string;
  cause?: SerializedError;
}

/** Converts unknown thrown values to a log-safe shape. */
export function serializeError(error: unknown, depth = 0): SerializedError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const serialized: SerializedError = { type: error.name, message: error.message };
    if (typeof code === 'string') serialized.code = code;
    if (error.stack) serialized.stack = error.stack;
    if (error.cause !== undefined && depth < 3) serialized.cause = serializeError(error.cause, depth + 1);
    return serialized;
  }
  return { type: typeof error, message: String(error) };
}

/** Coarse error classes used for log fields and bounded metric labels. */
export type ErrorClass =
  'validation' | 'auth' | 'not_found' | 'conflict' | 'dependency' | 'timeout' | 'internal';

export function classifyError(error: unknown): ErrorClass {
  const status = (error as { status?: unknown })?.status;
  if (typeof status === 'number') {
    if (status === 400 || status === 422) return 'validation';
    if (status === 401 || status === 403) return 'auth';
    if (status === 404) return 'not_found';
    if (status === 409 || status === 412) return 'conflict';
    if (status === 504) return 'timeout';
    if (status === 502 || status === 503) return 'dependency';
  }
  const name = (error as { name?: unknown })?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  return 'internal';
}
