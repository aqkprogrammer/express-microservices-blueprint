import type { ProblemDetails } from '@emb/contracts';

export interface FieldError {
  path: string;
  message: string;
}

/**
 * Base class for errors that map to an HTTP status. `expose` controls whether
 * `detail` is safe to show to clients; internal errors never leak their message.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly options: {
      expose?: boolean;
      errors?: FieldError[];
      cause?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
  }

  get expose(): boolean {
    return this.options.expose ?? this.status < 500;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, errors: FieldError[] = []) {
    super(400, 'validation_failed', message, { errors });
  }
}
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication is required') {
    super(401, 'unauthorized', message, { headers: { 'WWW-Authenticate': 'Bearer' } });
  }
}
export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(403, 'forbidden', message);
  }
}
export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'not_found', message);
  }
}
export class ConflictError extends AppError {
  constructor(message: string, code = 'conflict') {
    super(409, code, message);
  }
}
export class UnprocessableError extends AppError {
  constructor(message: string, code = 'unprocessable') {
    super(422, code, message);
  }
}
export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests', retryAfterSeconds?: number) {
    super(
      429,
      'rate_limited',
      message,
      retryAfterSeconds ? { headers: { 'Retry-After': String(retryAfterSeconds) } } : {},
    );
  }
}
export class ServiceUnavailableError extends AppError {
  constructor(message = 'A dependency is unavailable', cause?: unknown) {
    super(503, 'service_unavailable', message, { expose: true, cause, headers: { 'Retry-After': '5' } });
  }
}
/** A downstream service answered with an error or could not be reached. */
export class UpstreamError extends AppError {
  constructor(
    public readonly target: string,
    public readonly upstreamStatus: number | undefined,
    message: string,
    cause?: unknown,
    public readonly upstreamProblem?: ProblemDetails,
  ) {
    super(upstreamStatus === undefined ? 504 : 502, 'upstream_error', message, { expose: true, cause });
  }
}

/** Problem `type` URIs resolve to the error catalogue in this repository. */
export const PROBLEM_TYPE_BASE =
  'https://github.com/aqkprogrammer/express-microservices-blueprint/blob/main/docs/api/errors.md#';

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export const statusTitle = (status: number) => TITLES[status] ?? 'Error';

/** RFC 9457 problem document for an AppError. */
export function toProblem(error: AppError, instance?: string, requestId?: string): ProblemDetails {
  return {
    type: `${PROBLEM_TYPE_BASE}${error.code}`,
    title: statusTitle(error.status),
    status: error.status,
    code: error.code,
    ...(error.expose ? { detail: error.message } : {}),
    ...(instance ? { instance } : {}),
    ...(requestId ? { requestId } : {}),
    ...(error.options.errors?.length ? { errors: error.options.errors } : {}),
  };
}
