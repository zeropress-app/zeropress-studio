import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { StudioHonoEnvironment } from '../types';
import { timingSafeEqual } from './session-crypto';

export const SESSION_COOKIE_NAME = '__Host-zp_session';
export const SESSION_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_CSRF_HEADER = 'X-ZeroPress-CSRF';

const COOKIE_OPTIONS = {
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'Strict',
} as const;

export function readSessionCookie(
  c: Context<StudioHonoEnvironment>,
): string | undefined {
  return getCookie(c, SESSION_COOKIE_NAME);
}

export function setSessionCookie(
  c: Context<StudioHonoEnvironment>,
  value: string,
): void {
  setCookie(c, SESSION_COOKIE_NAME, value, {
    ...COOKIE_OPTIONS,
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(
  c: Context<StudioHonoEnvironment>,
): void {
  setCookie(c, SESSION_COOKIE_NAME, '', {
    ...COOKIE_OPTIONS,
    maxAge: 0,
    expires: new Date(0),
  });
}

export function isSameOriginMutation(
  c: Context<StudioHonoEnvironment>,
): boolean {
  const origin = c.req.header('Origin');
  if (!origin || origin !== new URL(c.req.url).origin) return false;
  const fetchSite = c.req.header('Sec-Fetch-Site');
  return fetchSite === undefined || fetchSite === 'same-origin';
}

export function hasValidCsrfHeader(
  c: Context<StudioHonoEnvironment>,
  expectedToken: string,
): boolean {
  const supplied = c.req.header(SESSION_CSRF_HEADER);
  return supplied !== undefined
    && timingSafeEqual(supplied, expectedToken);
}
