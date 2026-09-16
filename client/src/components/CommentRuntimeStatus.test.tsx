// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import {
  COMMENT_SETTINGS_DEFAULTS,
  type CommentSettings,
} from '../../../contracts/comment-settings';
import { CommentRuntimeStatus } from './CommentRuntimeStatus';

const copy = {
  loading: 'Checking runtime',
  active: 'Runtime active',
  disabled: 'Runtime disabled',
  integrationDisabled: 'Integration disabled',
  unconfigured: 'Runtime unconfigured',
  unavailable: 'Runtime unavailable',
  settingsLink: 'Open settings',
  edgeServicesLink: 'Open Edge Services',
};

function response(settings: CommentSettings) {
  return new Response(JSON.stringify({
    success: true,
    data: {
      settings,
      revision: '1'.repeat(32),
      updated_at_iso: null,
    },
  }), { headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CommentRuntimeStatus', () => {
  it('shows active runtime state to an editor without exposing settings navigation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      ...COMMENT_SETTINGS_DEFAULTS,
      api_base_url: 'https://edge.example.com/api',
    })));
    render(
      <MemoryRouter>
        <CommentRuntimeStatus
          roles={['editor']}
          onSessionEnded={vi.fn()}
          copy={copy}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Runtime active')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('links an administrator from an unconfigured item policy to Comment Settings', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      ...COMMENT_SETTINGS_DEFAULTS,
      api_base_url: null,
    })));
    render(
      <MemoryRouter>
        <CommentRuntimeStatus
          roles={['admin']}
          onSessionEnded={vi.fn()}
          copy={copy}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Runtime unconfigured')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open settings' }))
      .toHaveAttribute('href', '/settings/edge/comments');
  });
});
