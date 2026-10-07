import { passkeySettingsResponseSchema, type UpdatePasskeySettingsRequest } from '../../../contracts/passkey-settings';
import { studioFetch } from './studio-fetch';
export async function requestPasskeySettings(input: { signal?: AbortSignal; csrfToken?: string; body?: UpdatePasskeySettingsRequest } = {}) {
  const response = await studioFetch('/api/settings/passkeys', {
    method: input.body ? 'PUT' : 'GET', credentials: 'same-origin',
    signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    headers: { Accept: 'application/json', ...(input.body ? { 'Content-Type': 'application/json', 'X-ZeroPress-CSRF': input.csrfToken ?? '' } : {}) },
    body: input.body ? JSON.stringify(input.body) : undefined,
  });
  return passkeySettingsResponseSchema.parse(await response.json());
}
