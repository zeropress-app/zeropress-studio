// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { changeLocale } from '../i18n';
import { EdgeUrlSettings } from './EdgeUrlSettings';
import { EdgeEndpoint } from './EdgeEndpoint';

const onSessionEnded = vi.fn();
const document = (origin = '', revision = '0'.repeat(32)) => ({ settings: { edge_origin: origin }, revision, updated_at_iso: null });
const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { headers: { 'Content-Type': 'application/json' } });
beforeEach(async () => { await changeLocale('en'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Edge URL settings and connection addresses', () => {
  it('saves an origin with a revision and CSRF token, including a shared site hostname', async () => {
    const requests: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== '/api/settings/edge-url') throw new Error(`Unexpected request: ${url}`);
      if (init?.method === 'PUT') { requests.push(init); return response(document('https://site.example', 'a'.repeat(32))); }
      return response(document());
    }));
    const user = userEvent.setup();
    render(<MemoryRouter><EdgeUrlSettings csrfToken="csrf-example" onSessionEnded={onSessionEnded} /></MemoryRouter>);
    const field = await screen.findByRole('textbox', { name: 'Edge URL' });
    await user.type(field, 'https://SITE.example/');
    await user.click(screen.getByRole('button', { name: 'Save Edge URL' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(JSON.parse(String(requests[0]!.body))).toEqual({ settings: { edge_origin: 'https://site.example' }, expected_revision: '0'.repeat(32) });
    expect(requests[0]!.headers).toMatchObject({ 'X-ZeroPress-CSRF': 'csrf-example' });
    expect(field).toHaveValue('https://site.example');
    expect(screen.getByRole('button', { name: 'Save Edge URL' })).toBeDisabled();
  });

  it('keeps a conflicting edit for review and requires a reload', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'PUT'
      ? new Response(JSON.stringify({ success: false, error: { code: 'SETTINGS_REVISION_CONFLICT' } }), { status: 409 })
      : response(document('https://old.example'))));
    const user = userEvent.setup();
    render(<MemoryRouter><EdgeUrlSettings csrfToken="csrf-example" onSessionEnded={onSessionEnded} /></MemoryRouter>);
    const field = await screen.findByRole('textbox', { name: 'Edge URL' });
    await user.clear(field); await user.type(field, 'https://new.example');
    await user.click(screen.getByRole('button', { name: 'Save Edge URL' }));
    expect(await screen.findByRole('button', { name: 'Reload saved URL' })).toBeEnabled();
    expect(field).toHaveValue('https://new.example');
    expect(screen.getByRole('button', { name: 'Save Edge URL' })).toBeDisabled();
  });

  it.each(['form', 'newsletter'] as const)('copies the selected %s slug as a complete named config', async (kind) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url !== '/api/settings/edge-url') throw new Error(`Unexpected request: ${url}`);
      return response(document('https://site.example'));
    }));
    const user = userEvent.setup();
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<MemoryRouter><EdgeEndpoint kind={kind} slug="updates" onSessionEnded={onSessionEnded} /></MemoryRouter>);
    const url = `https://site.example/api/${kind === 'form' ? 'forms' : 'newsletters'}/updates`;
    expect(await screen.findByRole('textbox')).toHaveValue(url);
    expect(screen.getByRole('textbox')).toHaveAttribute('readonly');
    await user.click(screen.getByRole('button', { name: 'Copy config.json' }));
    expect(clipboard).toHaveBeenCalledWith(JSON.stringify({ [`${kind}_endpoint`]: url }, null, 2) + '\n');
  });

  it('directs an unconfigured connection to Edge URL settings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(document())));
    render(<MemoryRouter><EdgeEndpoint kind="comments" onSessionEnded={onSessionEnded} /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: 'Set Edge URL' })).toHaveAttribute('href', '/settings/edge#edge-url');
    expect(screen.getByText('Set an Edge URL to use this connection.')).toBeInTheDocument();
  });
});
