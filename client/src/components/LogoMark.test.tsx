// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { LogoBadge } from './LogoBadge';
import { LogoMark } from './LogoMark';

afterEach(() => {
  cleanup();
});

const CANONICAL = [
  ['top', '#EA7951', '0.6975 0.1502 39.9'],
  ['left', '#F19A6B', '0.7645 0.1217 48.6'],
  ['right', '#DC603F', '0.6386 0.1631 35.9'],
  ['bottom-left', '#EC8757', '0.7233 0.1389 45.3'],
  ['bottom-right', '#CD553A', '0.6002 0.1585 34.2'],
] as const;

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('LogoMark', () => {
  it('uses the canonical palette for all five faces of the inline mark', () => {
    const { container } = render(<LogoMark />);
    const fills = [...container.querySelectorAll('path')]
      .map((path) => path.getAttribute('fill'));

    expect(fills).toEqual(CANONICAL.map(([name, hex]) => (
      `var(--studio-logo-${name}, ${hex})`
    )));
    expect(container.querySelector('linearGradient')).toBeNull();
  });

  it('keeps app LogoMark tokens in one theme-independent palette', () => {
    const source = read('client/src/styles.css');

    for (const [name, hex, oklch] of CANONICAL) {
      expect(source).toContain(
        `--studio-logo-${name}: oklch(${oklch}); /* ${hex.toLowerCase()} */`,
      );
      expect(source.split(`--studio-logo-${name}:`)).toHaveLength(2);
    }
  });

  it('lets the shared badge own LogoMark\'s ink background and size', () => {
    const { container } = render(
      <LogoBadge className="test-owner" />,
    );
    const badge = container.firstElementChild;

    expect(badge).toHaveClass(
      'studio-logo-badge',
      'test-owner',
    );
    expect(badge?.querySelector('svg')).not.toBeNull();
  });

  it('uses the app\'s canonical colors and geometry for the favicon across themes', () => {
    const source = read('client/public/favicon.svg');
    const favicon = new DOMParser().parseFromString(source, 'image/svg+xml');
    const paths = [...favicon.querySelectorAll('path')];
    const { container } = render(<LogoMark />);

    expect(favicon.querySelector('parsererror')).toBeNull();
    expect(paths.map((path) => [path.getAttribute('class'), path.getAttribute('fill')]))
      .toEqual(CANONICAL.map(([name, hex]) => [name, hex]));
    expect(paths.map((path) => path.getAttribute('d'))).toEqual(
      [...container.querySelectorAll('path')].map((path) => path.getAttribute('d')),
    );
    expect(favicon.querySelector('style, linearGradient, radialGradient')).toBeNull();
    expect(source).not.toMatch(/prefers-color-scheme|@media|var\(|currentColor/iu);
  });
});
