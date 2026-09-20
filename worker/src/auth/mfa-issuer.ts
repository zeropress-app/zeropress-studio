import { normalizeSiteTitle } from '../../../contracts/general-settings';

export function resolveMfaIssuer(input: {
  requestUrl: string;
  siteTitle?: unknown;
}): string {
  const siteTitle = normalizeSiteTitle(input.siteTitle);
  // ASCII colons separate the issuer from the account in an otpauth label.
  const normalizeLabel = (value: string) => value
    .replaceAll(':', '：')
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim();
  const name = (siteTitle && normalizeLabel(siteTitle))
    || normalizeLabel(new URL(input.requestUrl).hostname);
  return `${name} · Studio`;
}

export async function readMfaIssuer(input: {
  db: D1Database;
  requestUrl: string;
}): Promise<string> {
  let siteTitle: unknown;
  try {
    const row = await input.db.prepare(`
      SELECT value FROM site_settings
      WHERE key = 'site_title' AND type = 'string'
      LIMIT 1
    `).first<{ value: string }>();
    siteTitle = row?.value;
  } catch {
    // Optional display metadata must not prevent account enrollment or recovery.
  }
  return resolveMfaIssuer({ requestUrl: input.requestUrl, siteTitle });
}
