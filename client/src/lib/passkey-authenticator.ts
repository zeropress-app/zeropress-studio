import metadata from './passkey-authenticator-metadata.json';
import type { PasskeyModel } from '../../../contracts/passkey-metadata';
const models: Record<string, PasskeyModel> = metadata.models as Record<string, PasskeyModel>;
export const PASSKEY_DISPLAY_SNAPSHOT = metadata.snapshot;
export function getPasskeyAuthenticatorModel(aaguid: string | null): PasskeyModel | null {
  return aaguid ? models[aaguid.toLowerCase()] ?? null : null;
}
export function getPasskeyAuthenticatorName(aaguid: string | null): string | null {
  return getPasskeyAuthenticatorModel(aaguid)?.name ?? null;
}
