import {
  testAnalyticsConnectionSchema,
  type AnalyticsSettings,
} from '../../../contracts/analytics';

type AnalyticsConnectionIds = Pick<
  AnalyticsSettings,
  'account_id' | 'site_tag'
>;

export const CLOUDFLARE_ANALYTICS_SITES_URL =
  'https://dash.cloudflare.com/?to=/:account/web-analytics/sites';

export const CLOUDFLARE_ANALYTICS_TOKEN_URL =
  'https://dash.cloudflare.com/?to=/:account/api-tokens' +
  `&permissionGroupKeys=${encodeURIComponent(
    JSON.stringify([{ key: 'account_analytics', type: 'read' }]),
  )}` +
  `&name=${encodeURIComponent('ZeroPress Studio Analytics')}`;

export function parseAnalyticsDashboardUrl(
  value: string,
): AnalyticsConnectionIds | null {
  const trimmed = value.trim();
  if (/[\s\\]/u.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (
      url.origin !== 'https://dash.cloudflare.com' ||
      url.username ||
      url.password
    )
      return null;
    const account = /^\/([a-f\d]{32})\/web-analytics\/overview\/?$/iu.exec(
      url.pathname,
    );
    const sites = url.searchParams.getAll('siteTag~in');
    if (!account || sites.length !== 1 || sites[0] !== sites[0]?.trim())
      return null;
    const parsed = testAnalyticsConnectionSchema.safeParse({
      account_id: account[1],
      site_tag: sites[0],
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createAnalyticsDashboardUrl(
  ids: AnalyticsConnectionIds,
): string {
  const parsed = testAnalyticsConnectionSchema.safeParse({
    account_id: ids.account_id,
    site_tag: ids.site_tag,
  });
  if (!parsed.success) return '';
  return `https://dash.cloudflare.com/${parsed.data.account_id}/web-analytics/overview?siteTag~in=${encodeURIComponent(parsed.data.site_tag)}`;
}
