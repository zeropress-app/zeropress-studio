// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeLocale } from '../i18n';
import { AiPageDraftDialog, AiPostDraftDialog } from './AiPostDraftDialog';

vi.mock('./ContentBodyEditor', () => ({
  ContentBodyEditor: (input: {
    value: string;
    documentType: string;
    editorMode: string;
  }) => (
    <div
      data-testid="generated-content-preview"
      data-document-type={input.documentType}
      data-editor-mode={input.editorMode}
    >
      {input.value}
    </div>
  ),
}));

const candidate = {
  title: 'Generated title',
  excerpt: 'Generated excerpt.',
  content: '<h2>Section</h2>\n<p>Generated body.</p>',
  document_type: 'html' as const,
  editor_mode: 'visual' as const,
  editor_profile: 'tiptap-v1' as const,
};

beforeEach(async () => {
  await changeLocale('en');
});

afterEach(cleanup);

describe('AiPostDraftDialog', () => {
  it('keeps a candidate outside the editor until selected fields are applied', async () => {
    const generate = vi.fn().mockResolvedValue({
      success: true,
      data: candidate,
    });
    const onApply = vi.fn();
    const user = userEvent.setup();
    render(
      <AiPostDraftDialog
        open
        currentTitle="Existing title"
        currentExcerpt=""
        target={{ document_type: 'html', editor_mode: 'visual' }}
        generate={generate}
        onApply={onApply}
        onClose={vi.fn()}
        onSessionEnded={vi.fn()}
      />,
    );

    await user.type(
      screen.getByRole('textbox', { name: 'Topic and writing notes' }),
      'Explain the practical workflow.',
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Tone' }),
      'professional',
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Length' }),
      'short',
    );
    await user.click(screen.getByRole('button', { name: 'Generate draft' }));

    expect(await screen.findByRole('dialog', {
      name: 'Review the generated Post draft',
    })).toBeInTheDocument();
    expect(generate).toHaveBeenCalledWith({
      title: 'Existing title',
      brief: 'Explain the practical workflow.',
      tone: 'professional',
      length: 'short',
      document_type: 'html',
      editor_mode: 'visual',
    }, expect.any(AbortSignal));
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', {
      name: 'Replace the current title with the generated title',
    })).not.toBeChecked();
    expect(screen.getByRole('checkbox', {
      name: 'Apply the generated excerpt',
    })).toBeChecked();
    expect(screen.getByTestId('generated-content-preview').textContent)
      .toBe(candidate.content);
    expect(screen.getByTestId('generated-content-preview'))
      .toHaveAttribute('data-document-type', 'html');
    expect(screen.getByTestId('generated-content-preview'))
      .toHaveAttribute('data-editor-mode', 'visual');

    await user.click(screen.getByRole('button', {
      name: 'Apply selected fields',
    }));
    expect(onApply).toHaveBeenCalledWith(candidate, {
      title: false,
      excerpt: true,
      content: true,
    });
  });

  it('reviews a Markdown candidate as read-only source without converting it', async () => {
    const markdownCandidate = {
      ...candidate,
      content: '## Section\n\nGenerated body.',
      document_type: 'markdown' as const,
      editor_mode: 'source' as const,
      editor_profile: null,
    };
    const generate = vi.fn().mockResolvedValue({
      success: true,
      data: markdownCandidate,
    });
    const user = userEvent.setup();
    render(
      <AiPostDraftDialog
        open
        currentTitle="Working title"
        currentExcerpt=""
        target={{ document_type: 'markdown', editor_mode: 'source' }}
        generate={generate}
        onApply={vi.fn()}
        onClose={vi.fn()}
        onSessionEnded={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Generate draft' }));
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      document_type: 'markdown',
      editor_mode: 'source',
    }), expect.any(AbortSignal));
    expect(await screen.findByTestId('generated-content-preview'))
      .toHaveAttribute('data-document-type', 'markdown');
    expect(screen.getByTestId('generated-content-preview'))
      .toHaveAttribute('data-editor-mode', 'source');
  });

  it('requires a title or brief and leaves manual editing available on failure', async () => {
    const generate = vi.fn().mockResolvedValue({
      success: false,
      error: { code: 'AI_SERVICE_UNAVAILABLE' },
    });
    const user = userEvent.setup();
    render(
      <AiPostDraftDialog
        open
        currentTitle=""
        currentExcerpt=""
        target={{ document_type: 'plaintext', editor_mode: 'source' }}
        generate={generate}
        onApply={vi.fn()}
        onClose={vi.fn()}
        onSessionEnded={vi.fn()}
      />,
    );

    const generateButton = screen.getByRole('button', {
      name: 'Generate draft',
    });
    expect(generateButton).toBeDisabled();
    const brief = screen.getByRole('textbox', {
      name: 'Topic and writing notes',
    });
    await user.type(brief, 'Draft a safe outline.');
    expect(generateButton).toBeEnabled();
    await user.click(generateButton);
    expect(await screen.findByText(/temporarily unavailable/))
      .toBeInTheDocument();
    expect(brief).toBeEnabled();
  });

  it('hands an expired authenticated session back to the application shell', async () => {
    const onSessionEnded = vi.fn();
    const user = userEvent.setup();
    render(
      <AiPostDraftDialog
        open
        currentTitle="Working title"
        currentExcerpt=""
        target={{ document_type: 'markdown', editor_mode: 'source' }}
        generate={vi.fn().mockResolvedValue({
          success: false,
          error: { code: 'AUTHENTICATION_REQUIRED' },
        })}
        onApply={vi.fn()}
        onClose={vi.fn()}
        onSessionEnded={onSessionEnded}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Generate draft' }));
    expect(onSessionEnded).toHaveBeenCalledOnce();
  });

  it('explains a stale contributor Author link without applying content', async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    render(
      <AiPostDraftDialog
        open
        currentTitle="Working title"
        currentExcerpt=""
        target={{ document_type: 'html', editor_mode: 'source' }}
        generate={vi.fn().mockResolvedValue({
          success: false,
          error: { code: 'POST_AUTHOR_NOT_LINKED' },
        })}
        onApply={onApply}
        onClose={vi.fn()}
        onSessionEnded={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Generate draft' }));
    expect(await screen.findByText(/no longer linked to a public Author/))
      .toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });
});

describe('AiPageDraftDialog', () => {
  it('requires writing notes for policy outlines and submits the selected purpose', async () => {
    const generate = vi.fn().mockResolvedValue({ success: true, data: candidate });
    const user = userEvent.setup();
    render(
      <AiPageDraftDialog
        open
        currentTitle="Privacy policy"
        currentExcerpt=""
        target={{ document_type: 'html', editor_mode: 'visual' }}
        generate={generate}
        onApply={vi.fn()}
        onClose={vi.fn()}
        onSessionEnded={vi.fn()}
      />,
    );

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Page purpose' }),
      'policy_outline',
    );
    const generateButton = screen.getByRole('button', { name: 'Generate draft' });
    expect(generateButton).toBeDisabled();
    expect(screen.getByText(/not legal advice or a compliance assurance/))
      .toBeInTheDocument();
    await user.type(
      screen.getByRole('textbox', { name: 'Purpose and Page notes' }),
      'We collect email addresses for account access.',
    );
    expect(generateButton).toBeEnabled();
    await user.click(generateButton);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      preset: 'policy_outline',
      brief: 'We collect email addresses for account access.',
    }), expect.any(AbortSignal));
  });
});
