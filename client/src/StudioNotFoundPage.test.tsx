// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { StudioAccessDeniedPage } from './StudioAccessDeniedPage';
import { StudioNotFoundPage } from './StudioNotFoundPage';
import './i18n';

afterEach(() => {
  cleanup();
  document.title = '';
});

/**
 * The two terminal screens.
 *
 * A missing route and denied access are different outcomes and need distinct headings and copy.
 * Both share the studio-not-found frame, so check both when updating it, including the
 * access-denied landmark name.
 */
describe('StudioNotFoundPage', () => {
  it('provides a named landmark and a route back to the dashboard', () => {
    render(
      <MemoryRouter>
        <StudioNotFoundPage />
      </MemoryRouter>,
    );

    const main = screen.getByRole('main', {
      name: 'Page not found',
    });
    expect(main).toHaveAttribute('id', 'studio-main-content');
    expect(within(main).getByRole('heading', { level: 1 }))
      .toHaveTextContent('Page not found');
    expect(main).toHaveTextContent('Check the address and try again.');
    expect(main).not.toHaveTextContent('Studio installation');
    expect(within(main).getByRole('link', { name: 'Return to Dashboard' }))
      .toHaveAttribute('href', '/');
  });

  it('hides the decorative 404 number from assistive technology', () => {
    render(
      <MemoryRouter>
        <StudioNotFoundPage />
      </MemoryRouter>,
    );

    // The number alone is insufficient; the kicker and heading explain the situation.
    const code = document.querySelector('.studio-not-found-code');
    expect(code).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('main').textContent).toContain('NOT FOUND');
  });

  it('can hide dashboard navigation on pre-authentication routes', () => {
    render(
      <MemoryRouter>
        <StudioNotFoundPage showReturnAction={false} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('link', { name: 'Return to Dashboard' }))
      .not.toBeInTheDocument();
  });

  it('updates the document title', () => {
    render(
      <MemoryRouter>
        <StudioNotFoundPage />
      </MemoryRouter>,
    );
    expect(document.title).toBe('Page not found · ZeroPress Studio');
  });
});

describe('StudioAccessDeniedPage', () => {
  it('provides a named landmark and a route back to the dashboard', () => {
    render(
      <MemoryRouter>
        <StudioAccessDeniedPage />
      </MemoryRouter>,
    );

    const main = screen.getByRole('main', {
      name: 'You cannot open this Studio page',
    });
    expect(main).toHaveAttribute('id', 'studio-main-content');
    expect(within(main).getByRole('link', { name: 'Return to Dashboard' }))
      .toHaveAttribute('href', '/');
  });

  it('explains that access is denied rather than the address being missing', () => {
    render(
      <MemoryRouter>
        <StudioAccessDeniedPage />
      </MemoryRouter>,
    );

    const main = screen.getByRole('main');
    expect(main.textContent).toContain('ACCESS DENIED');
    expect(main.textContent).toContain('You do not have permission to use this feature.');
    // Do not show a number that could imply a 404.
    expect(document.querySelector('.studio-not-found-code')).toBeNull();
  });

  it('updates the document title', () => {
    render(
      <MemoryRouter>
        <StudioAccessDeniedPage />
      </MemoryRouter>,
    );
    expect(document.title).toBe('Access denied · ZeroPress Studio');
  });
});
