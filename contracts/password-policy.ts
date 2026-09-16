import passwordBlocklistLong from './assets/password-blocklist-long.json';

export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 256;

export const INSTALL_PASSWORD_POLICY_REASONS = [
  'min_length',
  'max_length',
  'context_exact',
  'context_normalized_exact',
  'context_contains_identifier',
  'offline_common_password',
] as const;

export type InstallPasswordPolicyReason =
  typeof INSTALL_PASSWORD_POLICY_REASONS[number];

export type InstallPasswordAssessment = {
  allowed: boolean;
  reason?: InstallPasswordPolicyReason;
  requirements: {
    minimum_length: boolean;
    maximum_length: boolean;
    context_independent: boolean;
    uncommon: boolean;
  };
};

type PasswordContextInput = {
  password: string;
  email?: string;
  displayName?: string;
};

type ContextCandidate = {
  value: string;
};

const MIN_CONTAINS_TOKEN_LENGTH = 4;
const OFFLINE_BLOCKLIST = new Set(
  passwordBlocklistLong.map((entry) => normalizeText(entry)),
);

export function assessInstallPasswordPolicy(
  input: PasswordContextInput,
): InstallPasswordAssessment {
  const minimumLength = input.password.length >= PASSWORD_MIN_LENGTH;
  const maximumLength = input.password.length <= PASSWORD_MAX_LENGTH;
  const contextReason = checkContextPolicy(input);
  const uncommon = !OFFLINE_BLOCKLIST.has(normalizeText(input.password));

  const reason = !minimumLength
    ? 'min_length'
    : !maximumLength
      ? 'max_length'
      : contextReason
        ?? (!uncommon ? 'offline_common_password' : undefined);

  return {
    allowed: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
    requirements: {
      minimum_length: minimumLength,
      maximum_length: maximumLength,
      context_independent: contextReason === undefined,
      uncommon,
    },
  };
}

export function isPasswordInOfflineBlocklist(password: string): boolean {
  return OFFLINE_BLOCKLIST.has(normalizeText(password));
}

export function isContextPolicyReason(
  reason: InstallPasswordPolicyReason | undefined,
): boolean {
  return (
    reason === 'context_exact'
    || reason === 'context_normalized_exact'
    || reason === 'context_contains_identifier'
  );
}

function checkContextPolicy(
  input: PasswordContextInput,
): InstallPasswordPolicyReason | undefined {
  const passwordNormalized = normalizeText(input.password);
  const passwordAlnum = toAlnumOnly(input.password);
  const exactCandidates = collectExactCandidates(input);

  for (const candidate of exactCandidates) {
    if (passwordNormalized === candidate.value) {
      return 'context_exact';
    }
  }

  for (const candidate of exactCandidates) {
    const candidateAlnum = toAlnumOnly(candidate.value);
    if (candidateAlnum && passwordAlnum === candidateAlnum) {
      return 'context_normalized_exact';
    }
  }

  for (const candidate of collectContainsCandidates(input)) {
    const normalizedCandidate = normalizeText(candidate.value);
    const compactCandidate = toAlnumOnly(candidate.value);
    const matched = (
      normalizedCandidate.length >= MIN_CONTAINS_TOKEN_LENGTH
      && passwordNormalized.includes(normalizedCandidate)
    ) || (
      compactCandidate.length >= MIN_CONTAINS_TOKEN_LENGTH
      && passwordAlnum.includes(compactCandidate)
    );

    if (matched) {
      return 'context_contains_identifier';
    }
  }

  return undefined;
}

function collectExactCandidates(
  input: PasswordContextInput,
): ContextCandidate[] {
  const candidates: ContextCandidate[] = [];

  pushCandidate(candidates, input.email);
  pushCandidate(candidates, extractEmailLocalPart(input.email));
  pushCandidate(candidates, input.displayName);

  return dedupeCandidates(candidates);
}

function collectContainsCandidates(
  input: PasswordContextInput,
): ContextCandidate[] {
  const candidates: ContextCandidate[] = [];
  const emailLocalPart = extractEmailLocalPart(input.email);

  pushCandidate(candidates, emailLocalPart);
  pushCandidate(candidates, toAlnumOnly(emailLocalPart));

  for (const token of tokenize(input.displayName)) {
    pushCandidate(candidates, token);
  }

  return dedupeCandidates(candidates).filter((candidate) => (
    normalizeText(candidate.value).length >= MIN_CONTAINS_TOKEN_LENGTH
    || toAlnumOnly(candidate.value).length >= MIN_CONTAINS_TOKEN_LENGTH
  ));
}

function pushCandidate(
  candidates: ContextCandidate[],
  value: string | undefined,
): void {
  if (!value) {
    return;
  }

  const normalized = normalizeText(value);
  if (normalized) {
    candidates.push({ value: normalized });
  }
}

function dedupeCandidates(
  candidates: ContextCandidate[],
): ContextCandidate[] {
  const seen = new Set<string>();

  return candidates.filter((candidate) => {
    const key = candidate.value;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function extractEmailLocalPart(email?: string): string {
  if (!email) {
    return '';
  }

  const normalizedEmail = normalizeText(email);
  const atIndex = normalizedEmail.indexOf('@');
  return atIndex === -1
    ? normalizedEmail
    : normalizedEmail.slice(0, atIndex);
}

function tokenize(value?: string): string[] {
  if (!value) {
    return [];
  }

  return normalizeText(value)
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, ' ');
}

function toAlnumOnly(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}
