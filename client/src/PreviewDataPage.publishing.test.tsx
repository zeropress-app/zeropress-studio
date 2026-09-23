// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreparedPreviewData } from '../../contracts/preview-data';
import { PreviewDataPage } from './PreviewDataPage';
import { changeLocale } from './i18n';

const document: PreparedPreviewData = {
  data_hash: 'd'.repeat(64),
  preview_data: {
    version: '0.7', generator: 'synthetic/1.0', generated_at: '2026-09-23T00:00:00Z',
    site: { title: 'Example', description: '', url: '', media_origin: '', locale: 'en-US',
      posts_per_page: 10, date_style: 'medium', time_style: 'none', timezone: 'UTC', robots: { allow_indexing: false } },
    content: { authors: [], posts: [], pages: [], categories: [], tags: [] },
  },
  validation: { status: 'valid', contract_version: '0.7', warnings: [] },
};
const remoteFile = {
  target: { owner: 'example', repo: 'site', branch: 'main', path: 'preview.json' },
  blob_sha: 'b'.repeat(40), metadata_status: 'valid', data_hash: 'a'.repeat(64),
  commit: { sha: 'c'.repeat(40), url: 'https://github.com/example/site/commit/' + 'c'.repeat(40), committed_at_iso: '2026-09-22T00:00:00Z' },
};
beforeEach(async () => { await changeLocale('en'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup(mode: 'unconfigured' | 'disabled' | 'offline' | 'changed' | 'unchanged', holdPublish?: Promise<void>) {
  let statusReads = 0;
  let heldStatus: Promise<void> | undefined;
  let file = { ...remoteFile, data_hash: mode === 'unchanged' ? document.data_hash : remoteFile.data_hash };
  const writes: unknown[] = [];
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/preview-data/summary') return Response.json({ success: true, data: {
      authors: 0, posts: 0, pages: 0, categories: 0, tags: 0, menus: 0,
    } });
    if (path === '/api/preview-data') return Response.json({ success: true, data: document });
    if (path === '/api/publishing/status') {
      statusReads++;
      await heldStatus;
      if (mode === 'offline') return Response.json({ success: false, error: { code: 'PUBLISHING_UNAVAILABLE' } });
      return Response.json({ success: true, data: {
        configured: mode !== 'unconfigured', enabled: !['unconfigured', 'disabled'].includes(mode),
        revision: '0'.repeat(32), file: ['unconfigured', 'disabled'].includes(mode) ? null : file,
      } });
    }
    if (path === '/api/publishing' && init?.method === 'POST') {
      writes.push(JSON.parse(String(init.body)));
      await holdPublish;
      file = { ...file, data_hash: document.data_hash };
      return Response.json({ success: true, data: { outcome: 'committed', file } });
    }
    throw new Error(`Unexpected network call: ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  const user = userEvent.setup();
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  const download = vi.fn((_blob: Blob) => 'blob:synthetic-preview');
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = download;
    static revokeObjectURL = vi.fn();
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(<MemoryRouter><PreviewDataPage data={{ csrf_token: 'synthetic-csrf' }} onSessionEnded={vi.fn()} /></MemoryRouter>);
  return { user, writes, fetch, clipboard, download, statusReads: () => statusReads,
    holdStatus: (promise: Promise<void>) => { heldStatus = promise; } };
}
async function prepare(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Prepare data' }));
  await screen.findByRole('button', { name: 'Download Preview Data' });
}

describe('prepared data and optional publishing', () => {
  it.each(['unconfigured', 'disabled', 'offline'] as const)(
    'copies and downloads prepared data with GitHub %s', async (mode) => {
      const api = setup(mode);
      await prepare(api.user);
      await api.user.click(screen.getByRole('button', { name: 'Copy Preview Data' }));
      await api.user.click(screen.getByRole('button', { name: 'Download Preview Data' }));
      const expected = JSON.stringify(document.preview_data, null, 2) + '\n';
      expect(api.clipboard).toHaveBeenCalledWith(expected);
      const blob = api.download.mock.calls[0]?.[0] as unknown as Blob;
      expect(await blob.text()).toBe(expected);
      expect(api.writes).toHaveLength(0);
    },
  );
  it('exports while the GitHub comparison is pending and never enables an unchecked publish', async () => {
    const api = setup('changed');
    const publish = await screen.findByRole('button', { name: 'Publish to GitHub' });
    expect(publish).toBeDisabled();
    let release!: () => void;
    api.holdStatus(new Promise<void>((resolve) => { release = resolve; }));
    await prepare(api.user);
    await api.user.click(screen.getByRole('button', { name: 'Copy Preview Data' }));
    expect(api.clipboard).toHaveBeenCalledOnce();
    expect(publish).toBeDisabled();
    release();
    await waitFor(() => expect(publish).toBeEnabled());
  });
  it('shows an unchanged comparison without submitting a publish', async () => {
    const api = setup('unchanged');
    await prepare(api.user);
    expect(await screen.findByText('The prepared data is already on GitHub.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Publish to GitHub' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Download Preview Data' })).toBeEnabled();
    expect(api.writes).toHaveLength(0);
  });
  it('binds confirmation to prepared content and prevents regeneration during a write', async () => {
    let release!: () => void;
    const api = setup('changed', new Promise<void>((resolve) => { release = resolve; }));
    await prepare(api.user);
    const publish = screen.getByRole('button', { name: 'Publish to GitHub' });
    await waitFor(() => expect(publish).toBeEnabled());
    await api.user.click(publish);
    const dialog = screen.getByRole('dialog', { name: 'Publish to GitHub?' });
    await api.user.click(within(dialog).getByRole('button', { name: 'Publish to GitHub' }));
    // The modal makes the underlying preparation control inaccessible while writing.
    expect(screen.getByRole('button', { name: 'Prepare data again', hidden: true })).toBeDisabled();
    expect(api.writes).toEqual([{
      expected_revision: '0'.repeat(32), expected_data_hash: document.data_hash,
      expected_blob_sha: remoteFile.blob_sha,
    }]);
    release();
    expect(await screen.findByText('Updated on GitHub.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Publish to GitHub' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Prepare data again' })).toBeEnabled();
  });
});
