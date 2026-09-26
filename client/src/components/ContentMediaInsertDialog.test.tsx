// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeLocale } from '../i18n';
import { ContentMediaInsertDialog } from './ContentMediaInsertDialog';

vi.mock('./MediaPickerDialog', () => ({
  MediaPickerDialog: (input: { errorMessage: string | null; onSelect: (media: unknown) => void }) => (
    <div><button onClick={() => input.onSelect({})}>Insert fixture</button>
      {input.errorMessage ? <p role="alert">{input.errorMessage}</p> : null}</div>
  ),
}));
afterEach(cleanup);
beforeEach(async () => { await changeLocale('en'); });

describe('Media insertion guidance', () => {
  it.each([
    ['source_limit', /source content limit/],
    ['visual_limit', /visual editor size or element limit/],
    ['unavailable', /editor or selected image is no longer available/],
  ] as const)('shows guidance for %s and clears it after a successful retry', (reason, message) => {
    const onInsert = vi.fn().mockReturnValueOnce({ ok: false, reason }).mockReturnValueOnce({ ok: true });
    render(<ContentMediaInsertDialog onInsert={onInsert} onClose={() => {}} onSessionEnded={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Insert fixture' }));
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    fireEvent.click(screen.getByRole('button', { name: 'Insert fixture' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
