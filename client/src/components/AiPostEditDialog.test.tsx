// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeLocale } from '../i18n';
import { AiPostEditDialog } from './AiPostEditDialog';

vi.mock('./AiPostEditComparison', () => ({
  AiPostEditComparison: (input: {
    original: string;
    modified: string;
    copy: { originalLabel: string; modifiedLabel: string };
    onChange: (value: string) => void;
  }) => (
    <div>
      <textarea
        readOnly
        aria-label={input.copy.originalLabel}
        value={input.original}
      />
      <textarea
        aria-label={input.copy.modifiedLabel}
        value={input.modified}
        onChange={(event) => input.onChange(event.target.value)}
      />
    </div>
  ),
}));

beforeEach(async () => {
  await changeLocale('en');
});

afterEach(cleanup);

const selection = {
  kind: 'source' as const,
  selectionKind: 'source' as const,
  baseContent: 'Before selected words after',
  selectedContent: 'selected words',
  contextBefore: 'Before ',
  contextAfter: ' after',
  start: 7,
  end: 21,
};

describe('AiPostEditDialog', () => {
  it('keeps generation temporary and applies only the author-reviewed proposal', async () => {
    const generate = vi.fn().mockResolvedValue({
      success: true,
      data: { replacement: 'AI replacement' },
    });
    const onApply = vi.fn();
    const user = userEvent.setup();
    render(<AiPostEditDialog
      open
      expectedRevision={'a'.repeat(32)}
      target={{ document_type: 'plaintext', editor_mode: 'source' }}
      selection={selection}
      generate={generate}
      composeCandidate={(current, replacement) => current.kind === 'source'
        ? current.baseContent.slice(0, current.start)
          + replacement
          + current.baseContent.slice(current.end)
        : null}
      onApply={onApply}
      onClose={vi.fn()}
      onSessionEnded={vi.fn()}
    />);

    expect(screen.getByRole('textbox', { name: 'Selected source' }))
      .toHaveValue('selected words');
    await user.click(screen.getByRole('button', {
      name: 'Generate replacement',
    }));
    expect(await screen.findByRole('dialog', {
      name: 'Review the proposed edit',
    })).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
    const reviewed = screen.getByRole('textbox', {
      name: 'Reviewed proposal',
    });
    expect(reviewed).toHaveValue('Before AI replacement after');
    await user.clear(reviewed);
    await user.type(reviewed, 'Before author-reviewed replacement after');
    await user.click(screen.getByRole('button', {
      name: 'Apply reviewed edit',
    }));
    expect(onApply).toHaveBeenCalledWith(
      'Before author-reviewed replacement after',
    );
  });

  it('requires explicit expansion instructions before consuming AI capacity', async () => {
    const generate = vi.fn();
    const user = userEvent.setup();
    render(<AiPostEditDialog
      open
      expectedRevision={'a'.repeat(32)}
      target={{ document_type: 'plaintext', editor_mode: 'source' }}
      selection={selection}
      generate={generate}
      composeCandidate={() => null}
      onApply={vi.fn()}
      onClose={vi.fn()}
      onSessionEnded={vi.fn()}
    />);
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Operation' }),
      'expand',
    );
    expect(screen.getByRole('button', { name: 'Generate replacement' }))
      .toBeDisabled();
    expect(generate).not.toHaveBeenCalled();
  });
});
