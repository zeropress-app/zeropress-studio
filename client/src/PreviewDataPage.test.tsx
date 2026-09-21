// @vitest-environment jsdom

import { StrictMode } from 'react';
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STUDIO_PREVIEW_DATA_GENERATOR } from '../../contracts/studio-version';
import { StudioToaster } from './components/primitives';
import { changeLocale } from './i18n';
import { PreviewDataPage } from './PreviewDataPage';
vi.mock('./components/PublishingPanel', () => ({ PublishingPanel: () => null }));

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function summaryResponse() {
  return {
    success: true,
    data: {
      authors: 1,
      posts: 274,
      pages: 1,
      categories: 4,
      tags: 667,
      menus: 2,
    },
  };
}

function previewResponse(generatedAt = '2026-08-01T06:00:00Z') {
  return {
    success: true,
    data: {
      preview_data: {
        $schema: 'https://schemas.zeropress.dev/preview-data/v0.7/schema.json',
        version: '0.7',
        generator: STUDIO_PREVIEW_DATA_GENERATOR,
        generated_at: generatedAt,
        site: {
          title: 'ZeroPress',
          description: '',
          url: '',
          media_origin: '',
          locale: 'en-US',
          posts_per_page: 10,
          date_style: 'medium',
          time_style: 'none',
          timezone: 'UTC',
          robots: { allow_indexing: false },
        },
        content: {
          authors: [],
          posts: [],
          pages: [],
          categories: [],
          tags: [],
        },
      },
      validation: {
        status: 'valid',
        contract_version: '0.7',
        warnings: [],
      },
    },
  };
}

function renderPage(input: {
  onSessionEnded?: () => void;
  strict?: boolean;
} = {}) {
  const content = (
    <>
      <PreviewDataPage
        data={{ csrf_token: 'synthetic-csrf' }}
        onSessionEnded={input.onSessionEnded ?? vi.fn()}
      />
      <StudioToaster />
    </>
  );
  return render(input.strict ? <StrictMode>{content}</StrictMode> : content);
}

async function waitForSummary() {
  await screen.findByText('274');
  return screen.getByRole('button', { name: 'Generate Preview Data' });
}

async function generatePreviewData() {
  await userEvent.click(await waitForSummary());
  return screen.findByRole('button', { name: 'Download Preview Data' });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
});

describe('PreviewDataPage', () => {
  it('loads only count metadata on entry and waits for an explicit export action', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(summaryResponse()));
    vi.stubGlobal('fetch', fetchMock);
    renderPage({ strict: true });

    expect(screen.getByRole('heading', { name: 'Publish site' }))
      .toBeInTheDocument();
    expect(screen.getByText('Counting content…')).toBeInTheDocument();
    await waitForSummary();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/preview-data/summary');
    expect(screen.getByRole('heading', { name: 'Content to export' }))
      .toBeInTheDocument();
    const content = screen.getByRole('heading', {
      name: 'Content to export',
    }).closest('section');
    expect(content).not.toBeNull();
    expect(within(content!).getByText('667')).toBeInTheDocument();
    expect(screen.queryByText('Generated')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy Preview Data' }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download Preview Data' }))
      .not.toBeInTheDocument();
  });

  it('generates only after the explicit action and then reveals export actions', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(summaryResponse()))
      .mockResolvedValueOnce(response(previewResponse()));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    await generatePreviewData();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/preview-data');
    expect(screen.getByRole('button', { name: 'Copy Preview Data' }))
      .toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Included content' }))
      .toBeInTheDocument();
    expect(await screen.findByText('Preview Data was generated.'))
      .toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText((_content, element) => element?.tagName === 'CODE'))
      .not.toBeInTheDocument();
  });

  it('copies and downloads the exact same canonical JSON without displaying it', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(summaryResponse()))
      .mockResolvedValueOnce(response(previewResponse())));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const createObjectURL = vi.fn().mockReturnValue('blob:preview-data');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    renderPage();
    await generatePreviewData();

    await userEvent.click(screen.getByRole('button', {
      name: 'Copy Preview Data',
    }));
    expect(writeText).toHaveBeenCalledOnce();
    const copiedJson = writeText.mock.calls[0]?.[0];
    expect(copiedJson).toMatch(/^\{\n  "\$schema"/u);
    expect(copiedJson).toMatch(/\n\}\n$/u);
    expect(await screen.findByText('Preview Data copied.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', {
      name: 'Download Preview Data',
    }));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    const downloadedBlob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(await downloadedBlob.text()).toBe(copiedJson);
    expect(anchorClick).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-data');
  });

  it('regenerates directly without reloading the entry summary', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(summaryResponse()))
      .mockResolvedValueOnce(response(previewResponse()))
      .mockResolvedValueOnce(response(previewResponse(
        '2026-08-02T07:30:00Z',
      )));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    await generatePreviewData();

    await userEvent.click(screen.getByRole('button', {
      name: 'Generate again',
    }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await screen.findByRole('button', { name: 'Download Preview Data' });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/preview-data/summary',
      '/api/preview-data',
      '/api/preview-data',
    ]);
  });

  it('ends the session when explicit generation loses authentication', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(summaryResponse()))
      .mockResolvedValueOnce(response({
        success: false,
        error: { code: 'AUTHENTICATION_REQUIRED' },
      }, 401));
    vi.stubGlobal('fetch', fetchMock);
    const onSessionEnded = vi.fn();
    renderPage({ onSessionEnded });

    await userEvent.click(await waitForSummary());
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalledOnce());
  });

  it('keeps generation failures recoverable without exposing an invalid export', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(summaryResponse()))
      .mockResolvedValueOnce(response({
        success: false,
        error: { code: 'INTERNAL_ERROR' },
      }, 500))
      .mockResolvedValueOnce(response(previewResponse()));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    await userEvent.click(await waitForSummary());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Studio could not prepare Preview Data.',
    );
    expect(screen.queryByRole('button', { name: 'Download Preview Data' }))
      .not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'Download Preview Data' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('allows explicit generation when the lightweight count request fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        success: false,
        error: { code: 'INTERNAL_ERROR' },
      }, 500))
      .mockResolvedValueOnce(response(previewResponse()));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    expect(await screen.findByText('Content counts could not be loaded'))
      .toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', {
      name: 'Generate Preview Data',
    }));
    await screen.findByRole('button', { name: 'Download Preview Data' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
