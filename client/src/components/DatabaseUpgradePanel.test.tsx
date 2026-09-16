// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseUpgradeStatus } from '../../../contracts/database-upgrade';
import { changeLocale } from '../i18n';
import { DatabaseUpgradePanel } from './DatabaseUpgradePanel';

const operationsToken = 'operations-token-value-000000000000';
const firstStep = {
  id: '001_first',
  from_version: 1,
  to_version: 2,
  sha256: 'a'.repeat(64),
  statement_count: 2,
};
const secondStep = {
  id: '002_second',
  from_version: 2,
  to_version: 3,
  sha256: 'b'.repeat(64),
  statement_count: 1,
};
const status: DatabaseUpgradeStatus = {
  state: 'upgrade_required',
  current_schema_version: 1,
  target_schema_version: 3,
  available: true,
  operation_id: null,
  steps: [firstStep, secondStep],
  confirmation: 'UPGRADE STUDIO DATABASE',
};

beforeEach(async () => {
  await changeLocale('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DatabaseUpgradePanel', () => {
  it('verifies the administrator once and applies consecutive resumable steps', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          operation: 'upgrade_studio_database',
          status: 'started',
          operation_id: '1'.repeat(32),
          current_schema_version: 1,
          target_schema_version: 3,
          next_step: firstStep,
        },
      }), { headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          operation: 'upgrade_studio_database',
          status: 'in_progress',
          operation_id: '1'.repeat(32),
          applied_step: firstStep,
          current_schema_version: 2,
          target_schema_version: 3,
          next_step: secondStep,
        },
      }), { headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          operation: 'upgrade_studio_database',
          status: 'completed',
          operation_id: null,
          applied_step: secondStep,
          current_schema_version: 3,
          target_schema_version: 3,
          next_step: null,
        },
      }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const refreshStatus = vi.fn().mockResolvedValue({
      state: 'up_to_date',
      current_schema_version: 3,
      target_schema_version: 3,
      available: false,
      operation_id: null,
      steps: [],
      confirmation: 'UPGRADE STUDIO DATABASE',
    } satisfies DatabaseUpgradeStatus);
    const user = userEvent.setup();
    render(
      <DatabaseUpgradePanel
        token={operationsToken}
        status={status}
        refreshStatus={refreshStatus}
      />,
    );

    const requiredCallout = screen.getByText(
      'A database upgrade is required',
    ).closest('.studio-callout');
    expect(requiredCallout).toHaveClass('studio-notice-warning');
    expect(requiredCallout).toHaveTextContent(
      'Current version 1 · target version 3',
    );
    expect(requiredCallout?.closest('.operations-content-card'))
      .not.toBeNull();

    await user.type(
      screen.getByLabelText('Administrator email'),
      'owner@example.com',
    );
    await user.type(
      screen.getByLabelText('Administrator password'),
      'administrator-password',
    );
    await user.click(screen.getByLabelText(/I created and safely stored/));
    await user.type(
      screen.getByLabelText(/Type the exact confirmation phrase/),
      'UPGRADE STUDIO DATABASE',
    );
    await user.click(screen.getByRole('button', {
      name: 'Start database upgrade',
    }));

    expect(await screen.findByText(/database schema upgrade completed/i))
      .toHaveTextContent(/change STUDIO_SITE_MODE to operational/);
    expect(screen.getByText(/database schema upgrade completed/i))
      .toHaveTextContent(/return to maintenance if validation fails/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/system/operations/database-upgrade/start',
      '/api/system/operations/database-upgrade/step',
      '/api/system/operations/database-upgrade/step',
    ]);
    const startBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(startBody).toMatchObject({
      administrator_email: 'owner@example.com',
      backup_acknowledged: true,
    });
    const stepBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(stepBody).not.toHaveProperty('administrator_email');
    expect(stepBody).not.toHaveProperty('administrator_password');
    await waitFor(() => expect(refreshStatus).toHaveBeenCalledOnce());
  });

  it('reconciles a lost final response from the authoritative lifecycle status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('lost')));
    const refreshStatus = vi.fn().mockResolvedValue({
      state: 'up_to_date',
      current_schema_version: 3,
      target_schema_version: 3,
      available: false,
      operation_id: null,
      steps: [],
      confirmation: 'UPGRADE STUDIO DATABASE',
    } satisfies DatabaseUpgradeStatus);
    const user = userEvent.setup();
    render(
      <DatabaseUpgradePanel
        token={operationsToken}
        status={{
          state: 'in_progress',
          current_schema_version: 2,
          target_schema_version: 3,
          available: true,
          operation_id: '1'.repeat(32),
          steps: [secondStep],
          confirmation: 'UPGRADE STUDIO DATABASE',
        }}
        refreshStatus={refreshStatus}
      />,
    );

    await user.type(
      screen.getByLabelText(/Type the exact confirmation phrase/),
      'UPGRADE STUDIO DATABASE',
    );
    await user.click(screen.getByRole('button', {
      name: 'Resume database upgrade',
    }));
    expect(await screen.findByText(/database schema upgrade completed/i))
      .toBeInTheDocument();
    expect(refreshStatus).toHaveBeenCalledOnce();
  });
});
