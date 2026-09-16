// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assessInstallPasswordPolicy } from '../../../contracts/password-policy';
import { changeLocale } from '../i18n';
import { InstallPasswordAssessment } from './InstallPasswordAssessment';

vi.mock('zxcvbn', () => ({
  default: vi.fn(() => ({
    score: 3,
  })),
}));

const validInput = {
  password: 'harbor lantern canyon marble circuit',
  confirmPassword: 'harbor lantern canyon marble circuit',
  email: 'owner@example.com',
  displayName: 'Studio Owner',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
});

describe('InstallPasswordAssessment', () => {
  it('shows local policy results and a non-blocking lazy strength estimate', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const assessment = assessInstallPasswordPolicy(validInput);

    render(
      <InstallPasswordAssessment
        {...validInput}
        assessment={assessment}
        breach={{ status: 'clear', source: 'offline' }}
      />,
    );

    expect(
      await screen.findByText('Estimated strength: Strong'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('meter', {
        name: 'Estimated password strength',
      }),
    ).toHaveAttribute('aria-valuenow', '3');
    expect(
      screen.getByText('15–256 characters').closest('li'),
    ).toHaveAttribute('data-state', 'passed');
    expect(
      screen.getByText('Excludes administrator name and email ID')
        .closest('li'),
    ).toHaveAttribute('data-state', 'passed');
    expect(
      screen.getByText('Not in known compromised-password lists').closest('li'),
    ).toHaveAttribute('data-state', 'passed');
    expect(
      screen.getByText('Both password entries match').closest('li'),
    ).toHaveAttribute('data-state', 'passed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks common and mismatched passwords without relying on color alone', async () => {
    const input = {
      ...validInput,
      password: 'correct horse battery staple',
      confirmPassword: 'different password value',
    };

    render(
      <InstallPasswordAssessment
        {...input}
        assessment={assessInstallPasswordPolicy(input)}
        breach={{ status: 'idle' }}
      />,
    );

    expect(
      screen.getByText('Not in known compromised-password lists').closest('li'),
    ).toHaveAttribute('data-state', 'failed');
    expect(
      screen.getByText('Both password entries match').closest('li'),
    ).toHaveAttribute('data-state', 'failed');
    expect(screen.getAllByText('Requirement not met.')).toHaveLength(2);
  });

  it('uses the Korean resource without exposing raw zxcvbn feedback', async () => {
    await changeLocale('ko');

    render(
      <InstallPasswordAssessment
        {...validInput}
        assessment={assessInstallPasswordPolicy(validInput)}
        breach={{ status: 'clear', source: 'offline' }}
      />,
    );

    expect(
      await screen.findByText('예상 강도: 강함'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('두 비밀번호 입력값이 일치함'),
    ).toBeInTheDocument();
  });

  it('states when only the bundled list could be checked', () => {
    render(
      <InstallPasswordAssessment
        {...validInput}
        assessment={assessInstallPasswordPolicy(validInput)}
        breach={{ status: 'unavailable', source: 'hibp' }}
      />,
    );

    expect(screen.getByText(
      'Online check unavailable; checked against the bundled list only',
    ).closest('li')).toHaveAttribute('data-state', 'warning');
  });
});
