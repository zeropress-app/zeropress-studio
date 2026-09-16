// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EdgeDatabaseStatus } from '../../../contracts/edge-database-lifecycle';
import { changeLocale } from '../i18n';
import { EdgeDatabaseLifecyclePanel } from './EdgeDatabaseLifecyclePanel';

// Public v1 ships without an upgrade artifact. This synthetic pending step
// keeps the generic future-upgrade table presentation covered in isolation.
const status: EdgeDatabaseStatus = {
  state: 'upgrade_required',
  current_schema_version: 1,
  target_schema_version: 1,
  operation_id: null,
  next_upgrade_steps: [{
    id: 'edge_schema_1_to_2',
    from_version: 1,
    to_version: 2,
    sha256: 'a'.repeat(64),
    statement_count: 3,
  }],
  install_available: false,
  adopt_available: false,
  upgrade_available: true,
};

beforeEach(async () => {
  await changeLocale('en');
});

afterEach(cleanup);

describe('EdgeDatabaseLifecyclePanel', () => {
  it('labels and frames every pending schema upgrade field', () => {
    render(
      <EdgeDatabaseLifecyclePanel
        token="operations-token"
        status={status}
        studioDatabaseReady
        refreshStatus={async () => undefined}
      />,
    );

    const table = screen.getByRole('table', {
      name: 'Pending Edge schema steps',
    });
    expect(table.parentElement).toHaveClass('studio-table-scroll-framed');
    expect(table).toHaveClass('studio-table-stacked');
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent))
      .toEqual(['Upgrade step', 'Schema version', 'SQL statements']);
    expect(screen.getByRole('rowheader', { name: 'edge_schema_1_to_2' }))
      .toBeInTheDocument();
    expect(screen.getByText('1 → 2')).toHaveAttribute(
      'data-label',
      'Schema version',
    );
    expect(screen.getByText('3')).toHaveAttribute(
      'data-label',
      'SQL statements',
    );
  });
});
