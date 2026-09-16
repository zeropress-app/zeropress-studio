// @vitest-environment jsdom

import { useRef, useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from './Button';
import { Dialog } from './Dialog';

afterEach(cleanup);

describe('Dialog reading-first focus', () => {
  it('starts on its title and keeps both Tab directions inside the dialog', async () => {
    render(
      <Dialog open initialFocus="title" title="Media information" onClose={() => {}}>
        <p>Preview and metadata precede the controls.</p>
        <Button type="button">Copy reference</Button>
        <Button type="button">Close</Button>
      </Dialog>,
    );
    const heading = screen.getByRole('heading', { name: 'Media information' });
    const first = screen.getByRole('button', { name: 'Copy reference' });
    const last = screen.getByRole('button', { name: 'Close' });

    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute('tabindex', '-1');
    await userEvent.tab();
    expect(first).toHaveFocus();
    await userEvent.tab();
    expect(last).toHaveFocus();
    await userEvent.tab();
    expect(first).toHaveFocus();
    heading.focus();
    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it('returns focus to its trigger after Escape from the title', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button type="button" onClick={() => setOpen(true)}>Show information</Button>
          <Dialog
            open={open}
            initialFocus="title"
            title="Media information"
            onClose={() => setOpen(false)}
          >
            <Button type="button" onClick={() => setOpen(false)}>Close</Button>
          </Dialog>
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Show information' });
    await userEvent.click(trigger);
    expect(screen.getByRole('heading', { name: 'Media information' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('preserves explicit initial focus precedence', () => {
    function Harness() {
      const initialFocusRef = useRef<HTMLButtonElement>(null);
      return (
        <Dialog
          open
          initialFocus="title"
          initialFocusRef={initialFocusRef}
          title="Confirmation"
          onClose={() => {}}
        >
          <Button type="button">Confirm</Button>
          <Button type="button" ref={initialFocusRef}>Cancel</Button>
        </Dialog>
      );
    }
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });
});
