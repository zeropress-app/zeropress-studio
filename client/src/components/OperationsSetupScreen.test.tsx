// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationsSetupConfiguration } from '../../../contracts/system';
import { changeLocale } from '../i18n';
import { OperationsSetupScreen } from './OperationsSetupScreen';
import { StudioToaster } from './primitives';

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  await changeLocale('en');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'clipboard');
});

function renderSetup(configuration: OperationsSetupConfiguration = {
  allowed_ips: 'valid', token: 'missing',
}) {
  const onRetry = vi.fn();
  const result = render(<>
    <OperationsSetupScreen configuration={configuration} onRetry={onRetry} />
    <StudioToaster />
  </>);
  return { ...result, onRetry };
}

const states = ['valid', 'missing', 'invalid'] as const;
const clientIp = '203.0.113.10';
const setupCases: OperationsSetupConfiguration[] = [];
for (const allowed_ips of states) {
  for (const token of states) {
    if (allowed_ips !== 'valid') setupCases.push({ allowed_ips, token, client_ip: clientIp });
    else if (token !== 'valid') setupCases.push({ allowed_ips, token });
  }
}

describe('Operations configuration guide', () => {
  it.each(setupCases)('shows bounded $allowed_ips / $token states without prompting for credentials', (configuration) => {
    renderSetup(configuration);
    expect(document.querySelector('.standalone-status'))
      .toHaveClass('standalone-status-wide');
    const labels = { valid: 'Configured', missing: 'Not set', invalid: 'Invalid' };
    expect(screen.getByRole('region', { name: 'STUDIO_OPERATIONS_ALLOWED_IPS' }))
      .toHaveTextContent(labels[configuration.allowed_ips]);
    expect(screen.getByRole('region', { name: 'STUDIO_OPERATIONS_TOKEN' }))
      .toHaveTextContent(labels[configuration.token]);
    expect(screen.queryByRole('button', { name: 'Generate Operations token' }) !== null)
      .toBe(configuration.token !== 'valid');
    expect(screen.queryByLabelText('Current connection IP') !== null)
      .toBe(configuration.allowed_ips !== 'valid');
    expect(screen.queryByLabelText('Operations token')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Open setup guide' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveClass('auth-secret-guide-link');
    expect(within(screen.getByRole('region', { name: 'STUDIO_OPERATIONS_ALLOWED_IPS' }))
      .getByText('Plain variable')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'STUDIO_OPERATIONS_TOKEN' }))
      .getByText('Secret')).toBeInTheDocument();
  });

  it.each([clientIp, '2001:db8::1'])('displays a selectable readonly connection IP (%s)', async (ip) => {
    const user = userEvent.setup();
    renderSetup({ allowed_ips: 'missing', token: 'valid', client_ip: ip });
    const field = screen.getByLabelText('Current connection IP') as HTMLInputElement;
    expect(field).toHaveValue(ip);
    expect(field).toHaveAttribute('readonly');
    expect(field).toBeEnabled();
    expect(field).toHaveAccessibleDescription(/Your IP may change when you switch networks or VPNs/);
    await user.click(field);
    expect(field.selectionEnd! - field.selectionStart!).toBe(ip.length);
    await user.type(field, 'malformed');
    expect(field).toHaveValue(ip);
  });

  it('copies only the connection IP with a toast, without network requests or storage', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderSetup({ allowed_ips: 'invalid', token: 'valid', client_ip: clientIp });
    await user.click(screen.getByRole('button', { name: 'Copy IP address' }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(clientIp);
    await waitFor(() => {
      expect(screen.getByText('The current connection IP was copied.')).toBeVisible();
    });
    expect(screen.getByRole('button', { name: 'Copied' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(Object.values(localStorage).join()).not.toContain(clientIp);
    expect(Object.values(sessionStorage).join()).not.toContain(clientIp);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['denied', 'unavailable'])('allows manual IP copying when the clipboard is %s', async (state) => {
    const user = userEvent.setup();
    if (state === 'denied') {
      vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Denied'));
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
    renderSetup({ allowed_ips: 'missing', token: 'valid', client_ip: clientIp });
    await user.click(screen.getByRole('button', { name: 'Copy IP address' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not copy the IP address. Select and copy it manually.');
    const field = screen.getByLabelText('Current connection IP') as HTMLInputElement;
    expect(field).toHaveFocus();
    expect(field.selectionEnd! - field.selectionStart!).toBe(clientIp.length);
    expect(screen.queryByText('The current connection IP was copied.')).not.toBeInTheDocument();
  });

  it('does not invent a connection IP when it cannot be determined', () => {
    renderSetup({ allowed_ips: 'missing', token: 'valid', client_ip: null });
    expect(screen.getByText(/Studio could not determine your current connection IP/)).toBeVisible();
    expect(screen.queryByLabelText('Current connection IP')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy IP address' })).not.toBeInTheDocument();
  });

  it.each(['pagehide', 'new connection', 'unmount'])('ignores a late IP copy after %s', async (transition) => {
    const user = userEvent.setup();
    let completeCopy!: () => void;
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(() => new Promise<void>((resolve) => { completeCopy = resolve; }));
    const { rerender, onRetry } = renderSetup({ allowed_ips: 'missing', token: 'valid', client_ip: clientIp });
    await user.click(screen.getByRole('button', { name: 'Copy IP address' }));
    if (transition === 'pagehide') {
      act(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); });
    } else {
      rerender(<>
        {transition === 'new connection' ? <OperationsSetupScreen
          configuration={{ allowed_ips: 'missing', token: 'valid', client_ip: '2001:db8::2' }}
          onRetry={onRetry}
        /> : null}
        <StudioToaster />
      </>);
    }
    await act(async () => { completeCopy(); });
    expect(screen.queryByText('The current connection IP was copied.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
    if (transition === 'new connection') {
      expect(screen.getByLabelText('Current connection IP')).toHaveValue('2001:db8::2');
    }
  });

  it('generates and copies locally, with a toast and no persistent credential', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { onRetry } = renderSetup();

    await user.click(screen.getByRole('button', { name: 'Generate Operations token' }));
    const field = screen.getByLabelText('Generated STUDIO_OPERATIONS_TOKEN') as HTMLInputElement;
    expect(field).toHaveAttribute('readonly');
    expect(field.value).toMatch(/^[a-f0-9]{64}$/);
    const firstValue = field.value;
    expect(screen.getByText(/Keep a separate, secure copy/)).toHaveClass('auth-secret-retention-note');
    await user.click(screen.getByRole('button', { name: 'Copy value' }));
    expect(writeText).toHaveBeenCalledWith(firstValue);
    await waitFor(() => {
      expect(screen.getByText('The Operations token was copied.')).toBeVisible();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Generate another value' }));
    expect(field.value).not.toBe(firstValue);
    expect(screen.getByRole('button', { name: 'Copy value' })).toBeEnabled();
    expect(Object.values(localStorage).join()).not.toContain(firstValue);
    expect(Object.values(sessionStorage).join()).not.toContain(firstValue);
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Check configuration again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('selects the generated value when clipboard access fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Denied'));
    renderSetup();
    await user.click(screen.getByRole('button', { name: 'Generate Operations token' }));
    await user.click(screen.getByRole('button', { name: 'Copy value' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Select and copy it manually.');
    const field = screen.getByLabelText('Generated STUDIO_OPERATIONS_TOKEN') as HTMLInputElement;
    expect(field).toHaveFocus();
    expect(field.selectionEnd! - field.selectionStart!).toBe(field.value.length);
  });

  it('reports secure generation failure without creating a value', async () => {
    const user = userEvent.setup();
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(() => { throw new Error('Unavailable'); });
    renderSetup();
    await user.click(screen.getByRole('button', { name: 'Generate Operations token' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not generate a secure token');
    expect(screen.queryByLabelText('Generated STUDIO_OPERATIONS_TOKEN')).not.toBeInTheDocument();
  });

  it.each(['pagehide', 'pageshow'] as const)('clears generated values on %s and ignores a late clipboard result', async (type) => {
    const user = userEvent.setup();
    let completeCopy!: () => void;
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(() => new Promise<void>((resolve) => { completeCopy = resolve; }));
    renderSetup();
    await user.click(screen.getByRole('button', { name: 'Generate Operations token' }));
    await user.click(screen.getByRole('button', { name: 'Copy value' }));
    act(() => { window.dispatchEvent(new PageTransitionEvent(type, { persisted: true })); });
    await act(async () => { completeCopy(); });
    expect(screen.queryByLabelText('Generated STUDIO_OPERATIONS_TOKEN')).not.toBeInTheDocument();
    expect(screen.queryByText('The Operations token was copied.')).not.toBeInTheDocument();
  });

  it('provides Korean setup and retention copy', async () => {
    await changeLocale('ko');
    const user = userEvent.setup();
    renderSetup({ allowed_ips: 'missing', token: 'invalid', client_ip: clientIp });
    expect(screen.getByRole('heading', { name: 'Operations 접근을 설정하세요' })).toBeInTheDocument();
    expect(screen.getByLabelText('현재 접속 IP')).toHaveValue(clientIp);
    expect(screen.getByLabelText('현재 접속 IP')).toHaveAccessibleDescription(/네트워크나 VPN이 바뀌면 IP도 달라질 수 있습니다/);
    await user.click(screen.getByRole('button', { name: 'IP 주소 복사' }));
    await waitFor(() => {
      expect(screen.getByText('현재 접속 IP를 복사했습니다.')).toBeVisible();
    });
    await user.click(screen.getByRole('button', { name: 'Operations 토큰 생성' }));
    expect(screen.getByText('Operations에 접근할 때 필요하므로 이 값을 안전한 곳에 별도로 보관하세요.')).toBeInTheDocument();
  });
});
