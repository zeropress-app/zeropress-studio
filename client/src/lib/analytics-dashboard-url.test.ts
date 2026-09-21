import { describe, expect, it } from 'vitest';
import {
  createAnalyticsDashboardUrl,
  parseAnalyticsDashboardUrl,
} from './analytics-dashboard-url';

const ids = { account_id: 'a'.repeat(32), site_tag: 'b'.repeat(32) };
const dashboardUrl = `https://dash.cloudflare.com/${ids.account_id}/web-analytics/overview?siteTag~in=${ids.site_tag}`;

describe('Cloudflare Web Analytics dashboard URLs', () => {
  it('extracts the connection IDs and ignores report filters', () => {
    expect(
      parseAnalyticsDashboardUrl(
        `  ${dashboardUrl}&excludeBots=Yes&time-window=7d  `,
      ),
    ).toEqual(ids);
  });

  it('accepts encoded parameter names and normalizes the account ID', () => {
    expect(
      parseAnalyticsDashboardUrl(
        `https://dash.cloudflare.com/${ids.account_id.toUpperCase()}/web-analytics/overview/?excludeBots=Yes&siteTag%7Ein=${ids.site_tag}`,
      ),
    ).toEqual(ids);
  });

  it.each([
    ['missing URL', ''],
    [
      'site chooser',
      'https://dash.cloudflare.com/?to=/:account/web-analytics/sites',
    ],
    ['missing site', dashboardUrl.split('?')[0]!],
    ['empty site', dashboardUrl.replace(ids.site_tag, '')],
    ['repeated selector', `${dashboardUrl}&siteTag%7Ein=${ids.site_tag}`],
    ['multiple sites', `${dashboardUrl}%2C${'c'.repeat(32)}`],
    [
      'site list',
      dashboardUrl.replace(ids.site_tag, `%5B%22${ids.site_tag}%22%5D`),
    ],
    ['site whitespace', `${dashboardUrl}%20`],
    ['invalid account', dashboardUrl.replace(ids.account_id, 'unknown')],
    ['other screen', dashboardUrl.replace('/overview', '/sites')],
    ['insecure URL', dashboardUrl.replace('https:', 'http:')],
    ['other host', dashboardUrl.replace('dash.cloudflare.com', 'example.com')],
    [
      'lookalike host',
      dashboardUrl.replace(
        'dash.cloudflare.com',
        'dash.cloudflare.com.example.com',
      ),
    ],
    ['userinfo', dashboardUrl.replace('https://', 'https://user@')],
    ['nonstandard port', dashboardUrl.replace('.com/', '.com:8443/')],
    ['embedded newline', dashboardUrl.replace('overview', 'over\nview')],
    ['backslash', dashboardUrl.replace('/web-analytics/', '\\web-analytics/')],
  ])('rejects %s', (_description, value) => {
    expect(parseAnalyticsDashboardUrl(value)).toBeNull();
  });

  it('reconstructs a report URL from stored IDs without retaining pasted filters', () => {
    const parsed = parseAnalyticsDashboardUrl(
      `${dashboardUrl}&excludeBots=Yes`,
    )!;
    expect(createAnalyticsDashboardUrl(parsed)).toBe(dashboardUrl);
    const storedSettings = { ...ids, enabled: true };
    expect(createAnalyticsDashboardUrl(storedSettings)).toBe(dashboardUrl);
  });

  it('round-trips IDs accepted by the manual connection contract', () => {
    const manual = { account_id: 'A'.repeat(32), site_tag: 'site_123-ABC' };
    expect(
      parseAnalyticsDashboardUrl(createAnalyticsDashboardUrl(manual)),
    ).toEqual({
      ...manual,
      account_id: manual.account_id.toLowerCase(),
    });
  });

  it('leaves incomplete manual settings without a fabricated report URL', () => {
    expect(createAnalyticsDashboardUrl({ ...ids, site_tag: '' })).toBe('');
  });
});
