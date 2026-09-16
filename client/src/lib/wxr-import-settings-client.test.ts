// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { materializeRoutingSettingsDefaults } from '../../../contracts/routing-settings';
import { requestWxrImportSettingsFinalize } from './wxr-import-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WXR settings finalization client', () => {
  it('sends both revisioned documents to the dedicated finalization endpoint', async () => {
    const generalSettings = {
      title: 'Imported site',
      description: '',
      url: 'https://example.com',
      locale: 'en-US',
      timezone: 'UTC',
    };
    const routingSettings = materializeRoutingSettingsDefaults();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        general_settings: {
          result: 'updated',
          document: {
            settings: generalSettings,
            revision: '3'.repeat(32),
            updated_at_iso: '2026-08-13T03:00:00Z',
          },
        },
        routing_settings: {
          result: 'unchanged',
          document: {
            settings: routingSettings,
            revision: '2'.repeat(32),
            updated_at_iso: null,
          },
        },
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const request = {
      general_settings: {
        settings: generalSettings,
        expected_revision: '1'.repeat(32),
      },
      routing_settings: {
        settings: routingSettings,
        expected_revision: '2'.repeat(32),
      },
    };

    await expect(requestWxrImportSettingsFinalize({
      csrfToken: 'csrf-token',
      request,
    })).resolves.toMatchObject({
      success: true,
      data: {
        general_settings: { result: 'updated' },
        routing_settings: { result: 'unchanged' },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/imports/wxr/settings/finalize',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: expect.objectContaining({
          'X-ZeroPress-CSRF': 'csrf-token',
        }),
        body: JSON.stringify(request),
      }),
    );
  });
});
