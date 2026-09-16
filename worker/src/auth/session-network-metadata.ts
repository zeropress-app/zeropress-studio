export type SessionNetworkMetadata = {
  asn: number | null;
  asOrganization: string | null;
  countryCode: string | null;
};

function readCloudflareRequestMetadata(
  request: Request,
): Record<string, unknown> | null {
  const cf = (request as Request & { cf?: unknown }).cf;
  return typeof cf === 'object' && cf !== null && !Array.isArray(cf)
    ? cf as Record<string, unknown>
    : null;
}

function normalizeAutonomousSystemNumber(value: unknown): number | null {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    ? value
    : null;
}

function normalizeOrganization(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized ? normalized.slice(0, 255) : null;
}

function normalizeCountryCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9]{2,8}$/u.test(normalized) ? normalized : null;
}

export function readSessionNetworkMetadata(
  request: Request,
): SessionNetworkMetadata {
  const cf = readCloudflareRequestMetadata(request);
  return {
    asn: normalizeAutonomousSystemNumber(cf?.asn),
    asOrganization: normalizeOrganization(cf?.asOrganization),
    countryCode: normalizeCountryCode(cf?.country),
  };
}
