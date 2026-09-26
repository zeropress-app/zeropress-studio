// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { changeLocale } from '../i18n';
import { ContentPermalink } from './ContentPermalink';

const value = { revision: 'a'.repeat(32), url: 'https://site.example/post/42/', status: 'published' as const };
afterEach(cleanup);
beforeEach(() => changeLocale('en'));
it('opens a published permalink in a separate tab', () => {
  render(<ContentPermalink value={value} />);
  const link = screen.getByRole('link', { name: value.url });
  expect(link).toHaveAttribute('href', value.url);
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.getByText('Permalink')).toBeVisible();
});
it('shows a saved draft address as planned text', async () => {
  await changeLocale('ko');
  render(<ContentPermalink value={{ ...value, status: 'draft' }} />);
  expect(screen.getByText('예정 고유주소')).toBeVisible();
  expect(screen.getByText(value.url).tagName).toBe('SPAN');
});
