import { names } from './passkey-authenticator-names.json';

const authenticatorNames: Readonly<Record<string, string>> = names;

export function getPasskeyAuthenticatorName(aaguid: string | null): string | null {
  const key = aaguid?.toLowerCase();
  if (!key || key === '00000000-0000-0000-0000-000000000000') return null;
  return Object.hasOwn(authenticatorNames, key) ? authenticatorNames[key] : null;
}
