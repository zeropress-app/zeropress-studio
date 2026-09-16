// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { Search } from 'lucide-react';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { StudioIcon } from './StudioIcon';

afterEach(() => {
  cleanup();
});

describe('StudioIcon', () => {
  it('renders shared icons as decorative elements with a consistent stroke width', () => {
    const { container } = render(<StudioIcon icon={Search} />);
    const icon = container.querySelector('svg');

    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon).toHaveAttribute('focusable', 'false');
    expect(icon).toHaveAttribute('stroke-width', '1.75');
  });
});
