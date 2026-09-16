// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatStudioDocumentTitle,
  StudioSiteIdentityProvider,
  useStudioDocumentTitle,
} from './StudioSiteIdentityContext';

function TitledPage(input: { title: string }) {
  useStudioDocumentTitle(input.title);
  return null;
}

afterEach(cleanup);

describe('authenticated Studio document title', () => {
  it('prefixes the current site while preserving the translated product title', () => {
    expect(formatStudioDocumentTitle(
      'Posts · ZeroPress Studio',
      'Editorial Magazine',
    )).toBe('Editorial Magazine — Posts · ZeroPress Studio');
    expect(formatStudioDocumentTitle('Posts · ZeroPress Studio', ''))
      .toBe('Posts · ZeroPress Studio');
  });

  it('updates an open page when the site title changes', () => {
    const rendered = render(
      <StudioSiteIdentityProvider siteTitle="First Site">
        <TitledPage title="Dashboard · ZeroPress Studio" />
      </StudioSiteIdentityProvider>,
    );
    expect(document.title).toBe(
      'First Site — Dashboard · ZeroPress Studio',
    );

    rendered.rerender(
      <StudioSiteIdentityProvider siteTitle="Second Site">
        <TitledPage title="Dashboard · ZeroPress Studio" />
      </StudioSiteIdentityProvider>,
    );
    expect(document.title).toBe(
      'Second Site — Dashboard · ZeroPress Studio',
    );
  });
});
