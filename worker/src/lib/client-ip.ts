function normalizeIpv4(value: string): string | null {
  const segments = value.split('.');
  if (segments.length !== 4) return null;

  const normalized: string[] = [];
  for (const segment of segments) {
    if (
      !/^(?:0|[1-9]\d{0,2})$/u.test(segment)
      || Number(segment) > 255
    ) {
      return null;
    }
    normalized.push(String(Number(segment)));
  }
  return normalized.join('.');
}

export function normalizeIpAddress(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const ipv4 = normalizeIpv4(trimmed);
  if (ipv4) return ipv4;
  if (!trimmed.includes(':') || !/^[0-9a-f:.]+$/iu.test(trimmed)) return null;

  try {
    const parsed = new URL(`http://[${trimmed}]/`);
    if (
      parsed.username
      || parsed.password
      || parsed.port
      || !parsed.hostname.startsWith('[')
      || !parsed.hostname.endsWith(']')
    ) {
      return null;
    }
    return parsed.hostname.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
}

export function resolveTrustedClientIp(
  request: Request,
): string | null {
  const cloudflareIp = request.headers.get('CF-Connecting-IP');
  return cloudflareIp === null ? null : normalizeIpAddress(cloudflareIp);
}
