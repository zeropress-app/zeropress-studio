export const COMMENT_REQUEST_TOKEN_MESSAGE_PREFIX = 'v2:comments:';
export const COMMENT_REQUEST_PREVIOUS_KEY_TTL_DAYS = 14;

export type CommentTargetType = 'post' | 'page';

export type CommentRequestSecretEntry = {
  kid: string;
  secret: string;
  created_at: string;
  expires_at?: string;
};

export type CommentRequestSecrets = {
  version: 1;
  current: CommentRequestSecretEntry;
  previous: CommentRequestSecretEntry[];
};

const KID_PATTERN = /^k_[A-Za-z0-9_-]{22}$/u;
const UTC_SECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '');
}

function formatIsoUtcSeconds(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError('Comment request secret time must be valid.');
  }
  return value.toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

function isIsoUtcSeconds(value: string): boolean {
  if (!UTC_SECONDS_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    && formatIsoUtcSeconds(parsed) === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${path} must be a non-empty string.`);
  }
  return value.trim();
}

function parseEntry(value: unknown, path: string): CommentRequestSecretEntry {
  if (!isRecord(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  const kid = requiredString(value.kid, `${path}.kid`);
  const secret = requiredString(value.secret, `${path}.secret`);
  const createdAt = requiredString(value.created_at, `${path}.created_at`);
  if (!KID_PATTERN.test(kid)) {
    throw new TypeError(`${path}.kid has an invalid format.`);
  }
  if (!isIsoUtcSeconds(createdAt)) {
    throw new TypeError(`${path}.created_at must use UTC seconds.`);
  }

  const result: CommentRequestSecretEntry = {
    kid,
    secret,
    created_at: createdAt,
  };
  if (value.expires_at !== undefined) {
    const expiresAt = requiredString(value.expires_at, `${path}.expires_at`);
    if (!isIsoUtcSeconds(expiresAt)) {
      throw new TypeError(`${path}.expires_at must use UTC seconds.`);
    }
    result.expires_at = expiresAt;
  }
  return result;
}

export function parseCommentRequestSecrets(
  rawValue: string,
): CommentRequestSecrets {
  let value: unknown;
  try {
    value = JSON.parse(rawValue);
  } catch (error) {
    throw new TypeError('Comment request secrets must be valid JSON.', {
      cause: error,
    });
  }
  if (
    !isRecord(value)
    || value.version !== 1
    || !Array.isArray(value.previous)
  ) {
    throw new TypeError('Comment request secrets have an invalid shape.');
  }
  return {
    version: 1,
    current: parseEntry(value.current, 'current'),
    previous: value.previous.map((entry, index) => (
      parseEntry(entry, `previous[${index}]`)
    )),
  };
}

export function createCommentRequestSecrets(
  now = new Date(),
): CommentRequestSecrets {
  const kidBytes = new Uint8Array(16);
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(kidBytes);
  crypto.getRandomValues(secretBytes);
  return {
    version: 1,
    current: {
      kid: `k_${encodeBase64Url(kidBytes)}`,
      secret: encodeBase64Url(secretBytes),
      created_at: formatIsoUtcSeconds(now),
    },
    previous: [],
  };
}

export function rotateCommentRequestSecrets(
  current: CommentRequestSecrets,
  now = new Date(),
): CommentRequestSecrets {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new TypeError('Comment request secret rotation time must be valid.');
  }
  const expiresAt = new Date(
    nowMs + COMMENT_REQUEST_PREVIOUS_KEY_TTL_DAYS * 24 * 60 * 60 * 1_000,
  );
  return {
    version: 1,
    current: createCommentRequestSecrets(now).current,
    previous: [
      {
        ...current.current,
        expires_at: formatIsoUtcSeconds(expiresAt),
      },
      ...current.previous.filter((entry) => (
        entry.expires_at !== undefined
        && new Date(entry.expires_at).getTime() >= nowMs
      )),
    ],
  };
}

export async function createCommentRequestTokenSigner(
  secret: string,
): Promise<(input: {
  targetType: CommentTargetType;
  publicId: number;
  nonce: string;
}) => Promise<string>> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return async (input) => {
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(
        `${COMMENT_REQUEST_TOKEN_MESSAGE_PREFIX}${input.targetType}:${input.publicId}:${input.nonce}`,
      ),
    );
    return encodeBase64Url(new Uint8Array(signature));
  };
}
