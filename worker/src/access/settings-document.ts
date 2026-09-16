import type { Context } from 'hono';
import {
  CLOUDFLARE_ACCESS_ASSERTION_HEADER,
  type CloudflareAccessSettingsDocument,
} from '../../../contracts/cloudflare-access';
import type { StudioHonoEnvironment } from '../types';
import {
  verifyCloudflareAccessAssertion,
  type CloudflareAccessVerification,
  type VerifyCloudflareAccessAssertion,
} from './assertion-verifier';
import type { StoredCloudflareAccessDocument } from './settings-repository';

function detectionState(
  verification: CloudflareAccessVerification,
): CloudflareAccessSettingsDocument['detection_state'] {
  if (verification.state === 'missing') return 'not_detected';
  return verification.state;
}

export async function verifyCurrentCloudflareAccessRequest(input: {
  context: Context<StudioHonoEnvironment>;
  stored: StoredCloudflareAccessDocument;
  verifyAssertion?: VerifyCloudflareAccessAssertion;
  now?: Date;
}): Promise<CloudflareAccessVerification> {
  const middlewareIdentity = input.context.get('cloudflareAccessIdentity');
  if (middlewareIdentity) {
    return { state: 'verified', identity: middlewareIdentity };
  }
  return (input.verifyAssertion ?? verifyCloudflareAccessAssertion)({
    assertion: input.context.req.header(CLOUDFLARE_ACCESS_ASSERTION_HEADER),
    origin: new URL(input.context.req.url).origin,
    expected: input.stored.settings.mode === 'required'
      ? input.stored.settings
      : undefined,
    now: input.now,
  });
}

export function materializeCloudflareAccessSettingsDocument(
  stored: StoredCloudflareAccessDocument,
  verification: CloudflareAccessVerification,
): CloudflareAccessSettingsDocument {
  return {
    settings: stored.settings,
    revision: stored.revision,
    updated_at_iso: stored.updated_at_iso,
    detection_state: detectionState(verification),
    detected: verification.state === 'verified'
      ? verification.identity
      : null,
  };
}
