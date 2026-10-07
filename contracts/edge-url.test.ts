import { describe, expect, it } from 'vitest';
import { edgeEndpoint, edgeUrlSettingsInputSchema, normalizeEdgeOrigin } from './edge-url';

describe('Edge URL and endpoint contract', () => {
  it.each([
    ['', ''], [' https://EDGE.example:443/ ', 'https://edge.example'],
    ['https://site.example', 'https://site.example'],
    ['http://localhost:8787', 'http://localhost:8787'],
    ['http://127.0.0.1:8787/', 'http://127.0.0.1:8787'],
    ['http://[::1]:8787', 'http://[::1]:8787'],
  ])('normalizes %s', (value, expected) => {
    expect(edgeUrlSettingsInputSchema.parse({ edge_origin: value }).edge_origin).toBe(expected);
  });
  it.each([
    'http://edge.example', 'https://edge.example:8443', 'https://edge.example/api',
    'https://edge.example/api2/', 'https://edge.example/?x=1', 'https://edge.example/#x',
    'https://user:password@edge.example', '//edge.example', '/api',
    'https://edge.example/../', 'https://edge.example\\api', 'javascript:alert(1)',
  ])('rejects a non-origin address: %s', (value) => {
    expect(normalizeEdgeOrigin(value)).toBeNull();
  });
  it('derives fixed API routes on a shared site origin and uses the selected slug', () => {
    expect(edgeEndpoint('https://site.example', 'comments')).toBe('https://site.example/api');
    expect(edgeEndpoint('https://site.example', 'form', 'feedback')).toBe('https://site.example/api/forms/feedback');
    expect(edgeEndpoint('https://site.example', 'newsletter', 'updates')).toBe('https://site.example/api/newsletters/updates');
    expect(edgeEndpoint('', 'comments')).toBeNull();
  });
});
