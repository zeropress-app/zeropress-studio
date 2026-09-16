// @vitest-environment jsdom

import type { ComponentProps } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataTable } from './DataTable';

afterEach(cleanup);

function TableContents() {
  return (
    <>
      <thead>
        <tr>
          <th scope="col">Select</th>
          <th scope="col">Title</th>
          <th scope="col">Preview</th>
          <th scope="col">Description</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td data-label="Select" data-stack="select">Selected</td>
          <td data-label="Title" data-stack="primary">First Post</td>
          <td data-label="Preview" data-stack="preview">Image preview</td>
          <td data-label="Description" data-stack="wide">A longer description</td>
          <td data-label="Actions" data-stack="actions">Edit</td>
        </tr>
      </tbody>
    </>
  );
}

describe('DataTable compact layout', () => {
  it.each<ComponentProps<typeof DataTable>['stacked']>([
    undefined,
    false,
    true,
    'compact',
  ])('keeps stacked=%s opt-in and preserves the native table structure', (stacked) => {
    render(
      <DataTable caption="Posts" minWidthPx={760} stacked={stacked} framed>
        <TableContents />
      </DataTable>,
    );

    const table = screen.getByRole('table', { name: 'Posts' });
    const group = screen.getByRole('group', { name: 'Posts' });
    expect(table.tagName).toBe('TABLE');
    expect(table).toHaveStyle({ minWidth: '760px' });
    expect(table.classList.contains('studio-table-stacked')).toBe(Boolean(stacked));
    expect(table.classList.contains('studio-table-stacked-compact'))
      .toBe(stacked === 'compact');
    expect(group).toHaveAttribute('tabindex', '0');
    expect(group).toHaveClass('studio-table-scroll-framed');
    expect(within(table).getAllByRole('columnheader')).toHaveLength(5);
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getAllByRole('cell').map((cell) => [
      cell.tagName,
      cell.getAttribute('data-stack'),
      cell.getAttribute('data-label'),
    ])).toEqual([
      ['TD', 'select', 'Select'],
      ['TD', 'primary', 'Title'],
      ['TD', 'preview', 'Preview'],
      ['TD', 'wide', 'Description'],
      ['TD', 'actions', 'Actions'],
    ]);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('exposes one visible, controlled selection checkbox outside the table header', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const selection = {
      label: 'Select up to 10 Posts on this page',
      checked: false,
      onChange,
    };
    const { rerender } = render(
      <DataTable caption="Posts" stacked="compact" selection={selection}>
        <TableContents />
      </DataTable>,
    );

    const group = screen.getByRole('group', { name: 'Posts' });
    const checkbox = within(group).getByRole('checkbox', { name: selection.label });
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(within(group).getByText(selection.label)).toBeVisible();
    expect(checkbox).not.toBeChecked();
    expect(checkbox.closest('table')).toBeNull();
    expect(within(screen.getByRole('table')).queryByRole('checkbox'))
      .not.toBeInTheDocument();

    await user.click(checkbox);
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(checkbox).not.toBeChecked();

    rerender(
      <DataTable
        caption="Posts"
        stacked="compact"
        selection={{ ...selection, checked: true }}
      >
        <TableContents />
      </DataTable>,
    );
    expect(checkbox).toBeChecked();
    await user.click(checkbox);
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('reflects partial selection and clears the native indeterminate state on updates', () => {
    const selection = {
      label: 'Select this page',
      checked: false,
      indeterminate: true,
      onChange: vi.fn(),
    };
    const { rerender } = render(
      <DataTable caption="Posts" selection={selection}>
        <TableContents />
      </DataTable>,
    );
    const checkbox = screen.getByRole('checkbox', { name: selection.label });
    expect(checkbox).toBePartiallyChecked();

    rerender(
      <DataTable
        caption="Posts"
        selection={{ ...selection, checked: true, indeterminate: false }}
      >
        <TableContents />
      </DataTable>,
    );
    expect(checkbox).toBeChecked();
    expect(checkbox).not.toBePartiallyChecked();
  });

  it('does not change disabled selection', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DataTable
        caption="Posts"
        selection={{ label: 'Select this page', checked: false, disabled: true, onChange }}
      >
        <TableContents />
      </DataTable>,
    );
    const checkbox = screen.getByRole('checkbox', { name: 'Select this page' });
    expect(checkbox).toBeDisabled();
    await user.click(checkbox);
    expect(onChange).not.toHaveBeenCalled();
  });
});
