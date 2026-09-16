// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMemoryRouter,
  Link,
  RouterProvider,
} from 'react-router';
import { changeLocale } from '../i18n';
import { OperationsActivityGuard } from './OperationsActivityGuard';

afterEach(cleanup);

beforeEach(async () => {
  await changeLocale('en');
});

describe('OperationsActivityGuard', () => {
  it('keeps an active operation mounted and offers no force-leave action', async () => {
    const router = createMemoryRouter([{
      path: '/system/operations/database',
      element: (
        <>
          <h1>Database operation</h1>
          <Link to="/system/operations/edge">Edge services</Link>
          <OperationsActivityGuard active />
        </>
      ),
    }, {
      path: '/system/operations/edge',
      element: <h1>Edge services page</h1>,
    }], { initialEntries: ['/system/operations/database'] });
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();

    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    await user.click(screen.getByRole('link', { name: 'Edge services' }));

    expect(screen.getByRole('dialog', { name: 'Keep this page open' }))
      .toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/system/operations/database');
    expect(screen.getByText('Database operation')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);

    await user.click(screen.getByRole('button', {
      name: 'Stay on this page',
    }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/system/operations/database');
  });
});
