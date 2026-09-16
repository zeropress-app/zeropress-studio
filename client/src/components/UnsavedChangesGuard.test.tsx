// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMemoryRouter,
  Link,
  RouterProvider,
} from 'react-router';
import { UnsavedChangesGuard } from './UnsavedChangesGuard';

const copy = {
  kicker: 'UNSAVED',
  title: 'Store recovery copy?',
  description: 'The latest changes are not durable.',
  stay: 'Stay',
  leave: 'Autosave and leave',
  discard: 'Discard changes and leave',
  leaving: 'Autosaving…',
  leaveError: 'Autosave failed.',
  discarding: 'Discarding…',
  discardError: 'Discard failed.',
};

afterEach(cleanup);

describe('UnsavedChangesGuard', () => {
  it('flushes before a data-router navigation and proceeds on success', async () => {
    const onLeave = vi.fn().mockResolvedValue(true);
    const router = createMemoryRouter([{
      path: '/edit',
      element: (
        <>
          <h1>Editor</h1>
          <Link to="/next">Next</Link>
          <UnsavedChangesGuard active onLeave={onLeave} copy={copy} />
        </>
      ),
    }, {
      path: '/next',
      element: <h1>Next screen</h1>,
    }], { initialEntries: ['/edit'] });
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('link', { name: 'Next' }));
    expect(screen.getByRole('dialog', { name: copy.title }))
      .toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.leave }));

    expect(await screen.findByRole('heading', { name: 'Next screen' }))
      .toBeInTheDocument();
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('keeps the editor and pending history navigation when flush fails', async () => {
    const onLeave = vi.fn().mockResolvedValue(false);
    const router = createMemoryRouter([{
      path: '/previous',
      element: <h1>Previous screen</h1>,
    }, {
      path: '/edit',
      element: (
        <>
          <h1>Editor</h1>
          <UnsavedChangesGuard active onLeave={onLeave} copy={copy} />
        </>
      ),
    }], {
      initialEntries: ['/previous', '/edit'],
      initialIndex: 1,
    });
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();

    void router.navigate(-1);
    expect(await screen.findByRole('dialog', { name: copy.title }))
      .toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: copy.leave }));

    expect(await screen.findByText(copy.leaveError)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/edit');
  });

  it('discards the recovery copy and proceeds without flushing', async () => {
    const onLeave = vi.fn();
    const onDiscard = vi.fn().mockResolvedValue(true);
    const router = createMemoryRouter([{
      path: '/edit',
      element: (
        <>
          <Link to="/next">Next</Link>
          <UnsavedChangesGuard
            active
            onLeave={onLeave}
            onDiscard={onDiscard}
            copy={copy}
          />
        </>
      ),
    }, {
      path: '/next',
      element: <h1>Next screen</h1>,
    }], { initialEntries: ['/edit'] });
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('link', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: copy.discard }));

    expect(await screen.findByRole('heading', { name: 'Next screen' }))
      .toBeInTheDocument();
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onLeave).not.toHaveBeenCalled();
  });

  it('keeps the editor open when discarding the recovery copy fails', async () => {
    const onDiscard = vi.fn().mockResolvedValue(false);
    const router = createMemoryRouter([{
      path: '/edit',
      element: (
        <>
          <Link to="/next">Next</Link>
          <UnsavedChangesGuard
            active
            onDiscard={onDiscard}
            copy={copy}
          />
        </>
      ),
    }, {
      path: '/next',
      element: <h1>Next screen</h1>,
    }], { initialEntries: ['/edit'] });
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('link', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: copy.discard }));

    expect(await screen.findByText(copy.discardError)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/edit');
  });
});
