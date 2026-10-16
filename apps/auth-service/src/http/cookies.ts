import type { CookieOptions, Request, Response } from 'express';

export const REFRESH_COOKIE = 'emb_refresh_token';

/** HttpOnly + SameSite=Strict + path-scoped: the cookie is only ever sent to the auth endpoints. */
export function refreshCookieOptions(secure: boolean, maxAgeSeconds: number): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'strict', path: '/api/v1/auth', maxAge: maxAgeSeconds * 1000 };
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export function clearRefreshCookie(res: Response, secure: boolean): void {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure, sameSite: 'strict', path: '/api/v1/auth' });
}
