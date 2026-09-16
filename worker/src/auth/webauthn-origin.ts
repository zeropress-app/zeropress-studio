export type WebAuthnRequestContext = {
  origin: string;
  rpId: string;
};

function normalizeRpId(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.startsWith('[') && lower.endsWith(']')
    ? lower.slice(1, -1)
    : lower;
}

export function resolveWebAuthnRequestContext(
  requestUrl: string,
): WebAuthnRequestContext | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }

  const rpId = normalizeRpId(url.hostname);
  const localDevelopment = rpId === 'localhost'
    || rpId === '127.0.0.1'
    || rpId === '::1';
  if (
    !rpId
    || (
      url.protocol !== 'https:'
      && !(url.protocol === 'http:' && localDevelopment)
    )
  ) {
    return null;
  }

  return {
    origin: url.origin,
    rpId,
  };
}
