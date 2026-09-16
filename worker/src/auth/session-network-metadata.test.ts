import { describe, expect, it } from 'vitest';
import { readSessionNetworkMetadata } from './session-network-metadata';

function requestWithCf(cf?: unknown): Request {
  const request = new Request('https://studio.example.com/api/auth/mfa/verify');
  if (cf !== undefined) {
    Object.defineProperty(request, 'cf', { value: cf });
  }
  return request;
}

describe('session network metadata', () => {
  it('normalizes the Cloudflare connection snapshot', () => {
    expect(readSessionNetworkMetadata(requestWithCf({
      asn: 13335,
      asOrganization: '  Cloudflare,\u0000  Inc.  ',
      country: 'kr',
    }))).toEqual({
      asn: 13335,
      asOrganization: 'Cloudflare, Inc.',
      countryCode: 'KR',
    });
  });

  it('uses nullable metadata outside Cloudflare and rejects malformed values', () => {
    expect(readSessionNetworkMetadata(requestWithCf())).toEqual({
      asn: null,
      asOrganization: null,
      countryCode: null,
    });
    expect(readSessionNetworkMetadata(requestWithCf({
      asn: -1,
      asOrganization: '\u0000 \t',
      country: '../',
    }))).toEqual({
      asn: null,
      asOrganization: null,
      countryCode: null,
    });
  });

  it('bounds organization metadata and accepts Cloudflare special countries', () => {
    const result = readSessionNetworkMetadata(requestWithCf({
      asn: Number.MAX_SAFE_INTEGER,
      asOrganization: 'x'.repeat(300),
      country: 't1',
    }));
    expect(result.asn).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.asOrganization).toHaveLength(255);
    expect(result.countryCode).toBe('T1');
  });
});
