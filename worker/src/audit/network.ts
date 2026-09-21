import type { z } from 'zod';
import type { auditNetworkSchema } from '../../../contracts/audit-logs';
import { resolveTrustedClientIp } from '../lib/client-ip';
import { isConfiguredAuthSecret } from '../auth/mfa-crypto';
export type AuditNetwork = z.infer<typeof auditNetworkSchema>;
const clean = (value: unknown, max = 200): string | null => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) || null : null;
export function captureAuditNetwork(request: Request, now = new Date()): AuditNetwork {
  const cf = (request as Request & { cf?: Record<string, unknown> }).cf;
  const ip = resolveTrustedClientIp(request);
  return {
    ip_address: ip, ip_recorded_at: ip ? now.toISOString() : null, ip_hash: null,
    user_agent: clean(request.headers.get('User-Agent'), 1024), country: clean(cf?.country, 8),
    region: clean(cf?.region), city: clean(cf?.city), timezone: clean(cf?.timezone, 80),
    asn: typeof cf?.asn === 'number' && Number.isSafeInteger(cf.asn) && cf.asn > 0 ? cf.asn : null,
    organization: clean(cf?.asOrganization, 255),
  };
}
export async function hashAuditIp(ip: string, secret: string | undefined): Promise<string> {
  if (!isConfiguredAuthSecret(secret)) throw new Error('Audit IP key unavailable');
  const encoder = new TextEncoder();
  const source = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('zeropress-studio'),
    info: encoder.encode('audit-ip/v1'),
  }, source, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(`v1:${ip}`));
  return `v1.${Array.from(new Uint8Array(signed), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
