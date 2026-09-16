// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LazyMonacoSourceEditor } from './LazyMonacoSourceEditor';

const runtime = vi.hoisted(() => ({ unavailable: false }));

vi.mock('./MonacoSourceEditor', async () => {
  const React = await import('react');
  const module = await import('../test/MockMonacoSourceEditor');
  return {
    MonacoSourceEditor: (input: React.ComponentProps<
      typeof module.MockMonacoSourceEditor
    > & { onUnavailable: () => void }) => {
      React.useEffect(() => {
        if (runtime.unavailable) input.onUnavailable();
      }, [input.onUnavailable]);
      return runtime.unavailable
        ? null
        : <module.MockMonacoSourceEditor {...input} />;
    },
  };
});

const copy = {
  loading: 'Loading code editor…',
  failedTitle: 'Code editor unavailable',
  failedDescription: 'Source remains available.',
  retry: 'Retry code editor',
};

beforeEach(() => {
  runtime.unavailable = false;
});

afterEach(cleanup);

describe('LazyMonacoSourceEditor', () => {
  it('loads a language-aware controlled Monaco surface', async () => {
    const onChange = vi.fn();
    render(<>
      <label htmlFor="custom-css">CSS source</label>
      <LazyMonacoSourceEditor
        id="custom-css"
        value="body {}"
        documentType="css"
        disabled={false}
        label="CSS source"
        fallbackRows={16}
        copy={copy}
        onChange={onChange}
      />
    </>);

    const editor = await screen.findByRole('textbox', { name: 'CSS source' });
    expect(editor).toHaveAttribute('data-document-type', 'css');
    fireEvent.change(editor, { target: { value: 'body { color: red; }' } });
    expect(onChange).toHaveBeenCalledWith('body { color: red; }');
  });

  it('preserves the controlled value in a retryable textarea fallback', async () => {
    runtime.unavailable = true;
    const user = userEvent.setup();
    render(<>
      <label htmlFor="custom-html">body_end HTML source</label>
      <LazyMonacoSourceEditor
        id="custom-html"
        value={'<script>ready()</script>\n'}
        documentType="html"
        disabled={false}
        label="body_end HTML source"
        fallbackRows={14}
        copy={copy}
        onChange={vi.fn()}
      />
    </>);

    expect(await screen.findByText('Code editor unavailable')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'body_end HTML source' }))
      .toHaveValue('<script>ready()</script>\n');

    runtime.unavailable = false;
    await user.click(screen.getByRole('button', { name: 'Retry code editor' }));
    expect(await screen.findByRole('textbox', { name: 'body_end HTML source' }))
      .toHaveAttribute('data-document-type', 'html');
    expect(screen.queryByText('Code editor unavailable')).not.toBeInTheDocument();
  });
});
