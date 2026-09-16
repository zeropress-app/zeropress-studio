import {
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type RemoteJWKSet,
} from 'jose';
import {
  cloudflareAccessAudienceSchema,
  cloudflareAccessIssuerSchema,
  detectedCloudflareAccessSchema,
  type CloudflareAccessRequirement,
  type DetectedCloudflareAccess,
} from '../../../contracts/cloudflare-access';

const ACCESS_ASSERTION_MAX_BYTES = 32 * 1024;
const ACCESS_JWKS_TIMEOUT_MS = 4_000;
const ACCESS_JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1_000;
const ACCESS_JWKS_COOLDOWN_MS = 30 * 1_000;
const ACCESS_JWKS_MAX_BYTES = 256 * 1024;
const CLOUDFLARE_ACCESS_SUFFIX = '.cloudflareaccess.com';

type VerificationExpectation = Extract<
  CloudflareAccessRequirement,
  { mode: 'required' }
>;

export type CloudflareAccessVerification =
  | { state: 'missing' }
  | { state: 'invalid' }
  | { state: 'unavailable'; cause: unknown }
  | { state: 'verified'; identity: DetectedCloudflareAccess };

export type VerifyCloudflareAccessAssertion = (input: {
  assertion: string | undefined;
  origin: string;
  expected?: VerificationExpectation;
  now?: Date;
}) => Promise<CloudflareAccessVerification>;

const jwksResolvers = new Map<string, RemoteJWKSet>();

async function boundedResponse(
  response: Response,
  maximumBytes: number,
): Promise<Response> {
  const declaredLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new TypeError('Cloudflare Access JWKS response is too large.');
  }
  if (response.body === null) return response;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new TypeError('Cloudflare Access JWKS response is too large.');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function issuerJwksUrl(issuer: string): URL {
  return new URL('/cdn-cgi/access/certs', `${issuer}/`);
}

function teamDomainFromIssuer(issuer: string): string {
  return new URL(issuer).hostname.slice(0, -CLOUDFLARE_ACCESS_SUFFIX.length);
}

function candidateIdentity(assertion: string): DetectedCloudflareAccess | null {
  if (
    assertion.length === 0
    || new TextEncoder().encode(assertion).byteLength
      > ACCESS_ASSERTION_MAX_BYTES
  ) return null;

  let header: ReturnType<typeof decodeProtectedHeader>;
  let payload: ReturnType<typeof decodeJwt>;
  try {
    header = decodeProtectedHeader(assertion);
    payload = decodeJwt(assertion);
  } catch {
    return null;
  }
  if (
    header.alg !== 'RS256'
    || typeof header.kid !== 'string'
    || header.kid.length === 0
    || payload.type !== 'app'
    || !Array.isArray(payload.aud)
    || payload.aud.length !== 1
  ) return null;

  const issuer = cloudflareAccessIssuerSchema.safeParse(payload.iss);
  const audience = cloudflareAccessAudienceSchema.safeParse(payload.aud[0]);
  if (!issuer.success || !audience.success) return null;
  const identityEmail = typeof payload.email === 'string'
    && detectedCloudflareAccessSchema.shape.identity_email.safeParse(
      payload.email,
    ).success
    ? payload.email
    : null;
  const identity = detectedCloudflareAccessSchema.safeParse({
    issuer: issuer.data,
    team_domain: teamDomainFromIssuer(issuer.data),
    audience: audience.data,
    identity_email: identityEmail,
  });
  return identity.success ? identity.data : null;
}

function remoteJwks(issuer: string): RemoteJWKSet {
  const existing = jwksResolvers.get(issuer);
  if (existing) return existing;

  const jwksUrl = issuerJwksUrl(issuer);
  const resolver = createRemoteJWKSet(jwksUrl, {
    timeoutDuration: ACCESS_JWKS_TIMEOUT_MS,
    cooldownDuration: ACCESS_JWKS_COOLDOWN_MS,
    cacheMaxAge: ACCESS_JWKS_CACHE_MAX_AGE_MS,
    [customFetch]: async (url, options) => {
      if (url !== jwksUrl.href) {
        throw new TypeError('Unexpected Cloudflare Access JWKS URL.');
      }
      const headers = new Headers(options.headers);
      headers.set('Accept', 'application/json');
      const response = await fetch(url, {
        method: options.method,
        headers,
        // Cloudflare Workers does not implement `redirect: 'error'`.
        // `manual` preserves the no-follow boundary; jose rejects a
        // non-successful JWKS response before it is used for verification.
        redirect: 'manual',
        signal: options.signal,
      });
      return boundedResponse(response, ACCESS_JWKS_MAX_BYTES);
    },
  });
  jwksResolvers.set(issuer, resolver);
  return resolver;
}

function isVerificationRejection(error: unknown): boolean {
  if (!(error instanceof errors.JOSEError)) return false;
  return new Set([
    'ERR_JOSE_ALG_NOT_ALLOWED',
    'ERR_JOSE_NOT_SUPPORTED',
    'ERR_JWK_INVALID',
    'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
    'ERR_JWKS_NO_MATCHING_KEY',
    'ERR_JWS_INVALID',
    'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
    'ERR_JWT_CLAIM_VALIDATION_FAILED',
    'ERR_JWT_EXPIRED',
    'ERR_JWT_INVALID',
  ]).has(error.code);
}

export const verifyCloudflareAccessAssertion: VerifyCloudflareAccessAssertion =
  async (input) => {
    const assertion = input.assertion?.trim();
    if (!assertion) return { state: 'missing' };
    const candidate = candidateIdentity(assertion);
    if (!candidate) return { state: 'invalid' };

    if (
      input.expected
      && (
        input.origin !== input.expected.bound_origin
        || candidate.issuer !== input.expected.issuer
        || candidate.audience !== input.expected.audience
      )
    ) return { state: 'invalid' };

    try {
      const verified = await jwtVerify(
        assertion,
        remoteJwks(input.expected?.issuer ?? candidate.issuer),
        {
          algorithms: ['RS256'],
          issuer: input.expected?.issuer ?? candidate.issuer,
          audience: input.expected?.audience ?? candidate.audience,
          requiredClaims: ['iss', 'aud', 'exp', 'iat', 'nbf'],
          clockTolerance: 5,
          currentDate: input.now,
        },
      );
      if (verified.payload.type !== 'app') return { state: 'invalid' };
      return { state: 'verified', identity: candidate };
    } catch (error) {
      return isVerificationRejection(error)
        ? { state: 'invalid' }
        : { state: 'unavailable', cause: error };
    }
  };

export function resetCloudflareAccessJwksCacheForTests(): void {
  jwksResolvers.clear();
}
