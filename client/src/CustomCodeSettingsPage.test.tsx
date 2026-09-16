// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import {
  CUSTOM_CODE_SETTINGS_INITIAL_REVISION,
  CUSTOM_HTML_SLOT_MAX_CODE_POINTS,
  materializeCustomCodeSettingsDefaults,
} from '../../contracts/custom-code-settings';
import { CustomCodeSettingsPage } from './CustomCodeSettingsPage';
import { changeLocale } from './i18n';

vi.mock('./components/LazyMonacoSourceEditor', async () => {
  const module = await import('./test/MockMonacoSourceEditor');
  return { LazyMonacoSourceEditor: module.MockMonacoSourceEditor };
});

const initialDocument = {
  settings: materializeCustomCodeSettingsDefaults(),
  revision: CUSTOM_CODE_SETTINGS_INITIAL_REVISION,
  updated_at_iso: null,
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/settings/site/custom-code']}>
      <CustomCodeSettingsPage
        data={{ csrf_token: 'c'.repeat(43) }}
        onSessionEnded={vi.fn()}
      />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
});

describe('CustomCodeSettingsPage', () => {
  it('preserves drafts and saves all three activation states as one document', async () => {
    const savedSettings = {
      custom_css: {
        enabled: true,
        content: '  body { color: rebeccapurple; }\n',
      },
      custom_html: {
        head_end: {
          enabled: false,
          content: '  <meta name="draft" content="kept">\n',
        },
        body_end: {
          enabled: true,
          content: '\n<script>window.example = true;</script>\n',
        },
      },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ success: true, data: initialDocument }))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          settings: savedSettings,
          revision: '3'.repeat(32),
          updated_at_iso: '2026-08-04T03:00:00.000Z',
        },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Custom Code' }))
      .toBeInTheDocument();
    const cssEditor = await screen.findByLabelText('CSS source');
    const headEditor = await screen.findByLabelText('head_end HTML source');
    const bodyEditor = await screen.findByLabelText('body_end HTML source');
    const form = cssEditor.closest('form');
    // Each source has a sibling card; nested HTML cards waste mobile width.
    expect(form?.querySelectorAll(':scope > .studio-panel')).toHaveLength(3);
    expect(form?.querySelector('.studio-panel .studio-panel')).toBeNull();
    expect(screen.getByRole('heading', { name: 'HTML · head_end', level: 2 }))
      .toBeInTheDocument();
    expect(cssEditor).toHaveAttribute('data-document-type', 'css');
    expect(headEditor).toHaveAttribute('data-document-type', 'html');
    expect(bodyEditor).toHaveAttribute('data-document-type', 'html');
    fireEvent.change(cssEditor, { target: { value: savedSettings.custom_css.content } });
    fireEvent.change(headEditor, { target: { value: savedSettings.custom_html.head_end.content } });
    fireEvent.change(bodyEditor, { target: { value: savedSettings.custom_html.body_end.content } });
    await user.click(screen.getByRole('switch', { name: 'Include Custom CSS' }));
    await user.click(screen.getByRole('switch', { name: 'Include body_end' }));
    await user.click(screen.getByRole('button', { name: 'Save Custom Code' }));

    expect(await screen.findByText('Custom Code saved.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/settings/custom-code');
    expect(request.method).toBe('PUT');
    expect(request.headers).toMatchObject({
      'X-ZeroPress-CSRF': 'c'.repeat(43),
    });
    expect(JSON.parse(String(request.body))).toEqual({
      settings: savedSettings,
      expected_revision: CUSTOM_CODE_SETTINGS_INITIAL_REVISION,
    });
    await waitFor(() => expect(screen.getByText('All changes are saved.'))
      .toBeInTheDocument());
  });

  it('keeps an over-limit HTML draft visible and prevents submission', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      success: true,
      data: initialDocument,
    }));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    const bodyEditor = await screen.findByLabelText('body_end HTML source');
    fireEvent.change(bodyEditor, {
      target: { value: 'x'.repeat(CUSTOM_HTML_SLOT_MAX_CODE_POINTS + 1) },
    });

    expect(bodyEditor).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(
      'This slot exceeds the 65,536 Unicode code-point limit.',
    )).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Custom Code' }))
      .toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
