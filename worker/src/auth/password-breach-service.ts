import type { PasswordBreachAssessment } from '../../../contracts/password-breach';
import {
  assessInstallPasswordPolicy,
  isPasswordInOfflineBlocklist,
  type InstallPasswordAssessment,
} from '../../../contracts/password-policy';
import type { Env } from '../types';

const HIBP_RANGE_ENDPOINT = 'https://api.pwnedpasswords.com/range/';
const HIBP_CACHE_TTL_SECONDS = 24 * 60 * 60;
const HIBP_REQUEST_TIMEOUT_MS = 1_500;
const HIBP_CACHE_KEY_PREFIX = 'security:hibp:range:';
const HIBP_PASSWORD_BREACH_CHECK_ENABLED =
  typeof __ZEROPRESS_HIBP_PASSWORD_BREACH_CHECK_ENABLED__ === 'undefined'
    ? process.env.NODE_ENV !== 'test'
    : __ZEROPRESS_HIBP_PASSWORD_BREACH_CHECK_ENABLED__;

export type PasswordAcceptanceInput = {
  password: string;
  email?: string;
  displayName?: string;
};

export type PasswordAcceptanceAssessment = {
  allowed: boolean;
  local: InstallPasswordAssessment;
  breach: PasswordBreachAssessment;
};

export type CheckPasswordBreach = (input: {
  password: string;
  env: Env;
}) => Promise<PasswordBreachAssessment>;

function toUpperHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

async function sha1Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  return toUpperHex(await crypto.subtle.digest('SHA-1', bytes));
}

function rangeContainsSuffix(range: string, suffix: string): boolean {
  return range.split('\n').some((line) => {
    const separator = line.indexOf(':');
    const candidate = separator === -1 ? line : line.slice(0, separator);
    return candidate.trim().toUpperCase() === suffix;
  });
}

async function readCachedRange(
  kv: KVNamespace,
  key: string,
): Promise<string | null> {
  try {
    return await kv.get(key);
  } catch {
    return null;
  }
}

async function cacheRange(
  kv: KVNamespace,
  key: string,
  range: string,
): Promise<void> {
  try {
    await kv.put(key, range, { expirationTtl: HIBP_CACHE_TTL_SECONDS });
  } catch {
    // The cache is an optimization. A verified response remains authoritative.
  }
}

export async function checkPasswordBreach(input: {
  password: string;
  env: Env;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  hibpEnabled?: boolean;
}): Promise<PasswordBreachAssessment> {
  if (isPasswordInOfflineBlocklist(input.password)) {
    return { status: 'hit', source: 'offline' };
  }
  if (!(input.hibpEnabled ?? HIBP_PASSWORD_BREACH_CHECK_ENABLED)) {
    return { status: 'clear', source: 'offline' };
  }

  let digest: string;
  try {
    digest = await sha1Hex(input.password);
  } catch {
    return { status: 'unavailable', source: 'hibp' };
  }
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);
  const cacheKey = `${HIBP_CACHE_KEY_PREFIX}${prefix}`;
  const cached = await readCachedRange(input.env.KV, cacheKey);
  if (cached !== null) {
    return {
      status: rangeContainsSuffix(cached, suffix) ? 'hit' : 'clear',
      source: 'hibp',
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? HIBP_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await (input.fetchFn ?? fetch)(
      `${HIBP_RANGE_ENDPOINT}${prefix}`,
      {
        method: 'GET',
        headers: {
          'Add-Padding': 'true',
          'User-Agent': 'ZeroPress Studio',
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      return { status: 'unavailable', source: 'hibp' };
    }
    const range = await response.text();
    await cacheRange(input.env.KV, cacheKey, range);
    return {
      status: rangeContainsSuffix(range, suffix) ? 'hit' : 'clear',
      source: 'hibp',
    };
  } catch {
    return { status: 'unavailable', source: 'hibp' };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function assessPasswordAcceptance(input: {
  password: string;
  email?: string;
  displayName?: string;
  env: Env;
  checkBreach?: CheckPasswordBreach;
}): Promise<PasswordAcceptanceAssessment> {
  const local = assessInstallPasswordPolicy(input);
  if (!local.allowed) {
    return {
      allowed: false,
      local,
      breach: {
        status: local.requirements.uncommon ? 'clear' : 'hit',
        source: 'offline',
      },
    };
  }

  const breach = await (input.checkBreach ?? checkPasswordBreach)({
    password: input.password,
    env: input.env,
  });
  return {
    allowed: breach.status !== 'hit',
    local,
    breach,
  };
}
