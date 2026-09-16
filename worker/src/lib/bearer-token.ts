import { isValidStudioWorkerSecret } from '../../../contracts/worker-secret';

export function readBearerToken(
  authorizationHeader: string | undefined,
): string | null {
  if (!authorizationHeader) {
    return null;
  }

  const separatorIndex = authorizationHeader.indexOf(' ');
  if (
    separatorIndex <= 0
    || authorizationHeader.slice(0, separatorIndex).toLowerCase() !== 'bearer'
  ) {
    return null;
  }

  const token = authorizationHeader.slice(separatorIndex + 1);
  if (!isValidStudioWorkerSecret(token)) {
    return null;
  }

  return token;
}

async function digestToken(token: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return new Uint8Array(digest);
}

export async function secretTokensMatch(
  providedToken: string,
  configuredToken: string,
): Promise<boolean> {
  const [providedDigest, configuredDigest] = await Promise.all([
    digestToken(providedToken),
    digestToken(configuredToken),
  ]);

  let difference = 0;
  for (let index = 0; index < configuredDigest.length; index += 1) {
    difference |= providedDigest[index] ^ configuredDigest[index];
  }
  return difference === 0;
}
