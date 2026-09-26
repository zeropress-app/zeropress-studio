// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { changeLocale } from '../i18n';
import { ContentPreviewButton } from './ContentPreviewButton';
import { renderContentPreview } from '../editor/content-preview-client';

vi.mock('../editor/content-preview-client', () => ({ renderContentPreview: vi.fn() }));
const preview = vi.mocked(renderContentPreview);
const source = { title: 'Current draft', content: '<p>Pending input</p>', documentType: 'html' as const, baseUrl: 'https://site.example' };
afterEach(() => { cleanup(); vi.resetAllMocks(); });
beforeEach(async () => { await changeLocale('en'); preview.mockResolvedValue('<!doctype html><p>Preview</p>'); });

it('captures a fresh unsaved snapshot on opening and leaves editing to the caller', async () => {
  const user = userEvent.setup();
  const getSource = vi.fn(() => source);
  render(<ContentPreviewButton getSource={getSource} />);
  expect(getSource).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Preview' }));
  const frame = await screen.findByTitle('Body preview');
  expect(getSource).toHaveBeenCalledTimes(1);
  expect(preview).toHaveBeenCalledWith(expect.objectContaining(source), expect.any(AbortSignal));
  expect(frame).toHaveAttribute('sandbox', '');
  expect(frame).toHaveAttribute('srcdoc', '<!doctype html><p>Preview</p>');
  await user.click(screen.getByRole('button', { name: 'Mobile' }));
  expect(frame).toHaveClass('is-mobile');
  expect(getSource).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Desktop' }));
  expect(frame).not.toHaveClass('is-mobile');
  fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
  expect(screen.getByRole('dialog')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: 'Preview' })).toHaveFocus();
});

it('offers retry after rendering fails and cancels work when closed', async () => {
  const user = userEvent.setup();
  preview.mockRejectedValueOnce(new Error('Synthetic worker failure'));
  render(<ContentPreviewButton getSource={() => source} />);
  await user.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByText('The preview could not load. Your content is unchanged.')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByTitle('Body preview');
  const signal = preview.mock.calls.at(-1)![1];
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(signal.aborted).toBe(true));
});

it('supports Korean labels and keyboard opening', async () => {
  await changeLocale('ko');
  const user = userEvent.setup();
  render(<ContentPreviewButton getSource={() => source} />);
  await user.tab();
  await user.keyboard('{Enter}');
  expect(await screen.findByTitle('본문 미리보기')).toBeVisible();
  expect(screen.getByRole('button', { name: '모바일' })).toBeVisible();
  expect(preview).toHaveBeenCalledWith(expect.objectContaining({
    labels: expect.objectContaining({ linkDetails: '링크 정보', address: '주소', newWindow: '새 창 (_blank)', embedTitle: '외부 콘텐츠' }),
  }), expect.any(AbortSignal));
});
