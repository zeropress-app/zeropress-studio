// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Switch, SwitchGroup } from './Switch';

afterEach(() => {
  cleanup();
});

describe('Switch', () => {
  it('keeps supporting text out of the accessible name', () => {
    // Wrapping the switch in a label used to include its whole description in the name.
    // Use only the label as the name and connect the description through describedby.
    render(
      <Switch
        label="Enable comments"
        description="Eligible posts and pages can enable comment islands."
        checked
        onChange={() => {}}
      />,
    );
    const control = screen.getByRole('switch', { name: 'Enable comments' });
    expect(control).toBeChecked();
    expect(control).toHaveAccessibleDescription(
      'Eligible posts and pages can enable comment islands.',
    );
  });

  it('omits describedby when there is no description', () => {
    // A label alone can be sufficient for a list-item toggle. Omit describedby
    // when there is no description so it cannot reference a missing element.
    render(<Switch label="Enable this widget" checked={false} onChange={() => {}} />);
    expect(screen.getByRole('switch', { name: 'Enable this widget' }))
      .not.toHaveAttribute('aria-describedby');
  });

  it('associates each label with its own control when several switches are rendered', () => {
    render(
      <SwitchGroup>
        <Switch
          label="Static search"
          description="Build a search index."
          checked
          onChange={() => {}}
        />
        <Switch
          label="RSS feed"
          description="Generate a feed."
          checked={false}
          onChange={() => {}}
        />
      </SwitchGroup>,
    );
    // Generate IDs internally so callers cannot supply duplicates.
    expect(screen.getByRole('switch', { name: 'Static search' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'RSS feed' })).not.toBeChecked();
  });

  it('toggles the value when the label is clicked', async () => {
    const onChange = vi.fn();
    render(
      <Switch
        label="Allow indexing"
        description="Allow search engines to index the site."
        checked={false}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByText('Allow indexing'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('keeps the value unchanged when disabled', async () => {
    const onChange = vi.fn();
    render(
      <Switch
        label="Allow indexing"
        description="Allow search engines to index the site."
        checked={false}
        disabled
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole('switch', { name: 'Allow indexing' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
