// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeLocale } from '../i18n';
import { AiExcerptField } from './AiExcerptField';

const source = {
  title: 'Current title',
  content: '<p>Current unsaved body.</p>',
  document_type: 'html' as const,
};

beforeEach(async () => {
  await changeLocale('en');
});

afterEach(cleanup);

describe('AiExcerptField', () => {
  it('keeps the generated result out of the draft until explicit review', async () => {
    const generate = vi.fn().mockResolvedValue({
      success: true,
      data: {
        excerpt: 'A generated excerpt.',
        source_truncated: false,
      },
    });
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AiExcerptField
        label="Excerpt"
        hint="Explicit summary"
        value="Current excerpt."
        getSource={() => source}
        generate={generate}
        onChange={onChange}
        onSessionEnded={vi.fn()}
      />,
    );

    expect(generate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Generate with AI' }));
    expect(await screen.findByRole('dialog', {
      name: 'Replace the current excerpt?',
    })).toBeInTheDocument();
    expect(generate).toHaveBeenCalledWith(source, expect.any(AbortSignal));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Current excerpt' }))
      .toHaveValue('Current excerpt.');
    expect(screen.getByRole('textbox', { name: 'Generated excerpt' }))
      .toHaveValue('A generated excerpt.');

    await user.click(screen.getByRole('button', { name: 'Apply to draft' }));
    expect(onChange).toHaveBeenCalledWith('A generated excerpt.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(/has not been saved yet/)).toBeInTheDocument();
  });

  it('can discard a truncated-source candidate without changing the draft', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AiExcerptField
        label="Excerpt"
        hint="Explicit summary"
        value=""
        getSource={() => source}
        generate={vi.fn().mockResolvedValue({
          success: true,
          data: {
            excerpt: 'A bounded excerpt.',
            source_truncated: true,
          },
        })}
        onChange={onChange}
        onSessionEnded={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Generate with AI' }));
    expect(await screen.findByText(/based on its beginning and end/))
      .toBeInTheDocument();
    await user.click(screen.getByRole('button', {
      name: 'Keep current excerpt',
    }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('presents bounded API errors while manual editing remains available', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <AiExcerptField
        label="Excerpt"
        hint="Explicit summary"
        value=""
        getSource={() => source}
        generate={vi.fn().mockResolvedValue({
          success: false,
          error: { code: 'AI_SERVICE_UNAVAILABLE' },
        })}
        onChange={onChange}
        onSessionEnded={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Generate with AI' }));
    expect(await screen.findByText(/temporarily unavailable/))
      .toBeInTheDocument();
    const excerpt = screen.getByRole('textbox', { name: 'Excerpt' });
    expect(excerpt).toBeEnabled();
    await user.type(excerpt, 'Manual excerpt');
    expect(onChange).toHaveBeenCalled();
  });

  it('hands an expired authenticated session back to the application shell', async () => {
    const onSessionEnded = vi.fn();
    const user = userEvent.setup();
    render(
      <AiExcerptField
        label="Excerpt"
        hint="Explicit summary"
        value=""
        getSource={() => source}
        generate={vi.fn().mockResolvedValue({
          success: false,
          error: { code: 'AUTHENTICATION_REQUIRED' },
        })}
        onChange={vi.fn()}
        onSessionEnded={onSessionEnded}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Generate with AI' }));
    expect(onSessionEnded).toHaveBeenCalledOnce();
  });
});
