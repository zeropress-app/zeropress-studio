// @vitest-environment jsdom

import { act } from 'react';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { MemoryRouter } from 'react-router';
import i18n from '../../i18n';
import {
  StudioToaster,
  studioToast,
  useStudioToast,
} from './StudioToast';

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('StudioToaster', () => {
  it('keeps a new completion visible after the initial empty state', async () => {
    vi.useFakeTimers();

    function Completion({ message }: { message: string | null }) {
      useStudioToast({ id: 'completion', tone: 'success', message });
      return null;
    }

    const { rerender } = render(<>
      <StudioToaster />
      <Completion message={null} />
    </>);

    act(() => { vi.advanceTimersToNextFrame(); });
    rerender(<>
      <StudioToaster />
      <Completion message="Value copied." />
    </>);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText('Value copied.')).toBeVisible();

    act(() => { vi.advanceTimersToNextFrame(); });
    expect(screen.getByText('Value copied.')).toBeVisible();
  });

  it('keeps a new completion visible while the previous toast finishes dismissing', async () => {
    vi.useFakeTimers();
    render(<StudioToaster />);

    act(() => { studioToast.success({ id: 'copy-lifetime', message: 'First copy.' }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText('First copy.')).toBeVisible();

    act(() => { studioToast.dismiss('copy-lifetime'); });
    act(() => { vi.advanceTimersToNextFrame(); });
    act(() => { studioToast.success({ id: 'copy-lifetime', message: 'Next copy.' }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText('Next copy.')).toBeVisible();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByText('Next copy.')).toBeVisible();
  });

  it('provides a polite live region and a translated dismiss button', async () => {
    render(<StudioToaster />);

    act(() => {
      studioToast.success({ id: 'saved', message: 'Settings saved.' });
    });

    const region = screen.getByRole('region', {
      name: 'Notifications alt+T',
    });
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-relevant', 'additions text');
    expect(region).toHaveAttribute('aria-atomic', 'false');
    await waitFor(() => {
      expect(screen.getByText('Settings saved.')).toBeVisible();
    });
    expect(screen.getByText('Success:')).toHaveClass('visually-hidden');
    expect(screen.getByRole('button', { name: 'Close notification' }))
      .toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('updates the message for an existing operation ID instead of adding a duplicate', async () => {
    render(<StudioToaster />);

    act(() => {
      studioToast.info({ id: 'copy', message: 'Copied once.' });
      studioToast.info({ id: 'copy', message: 'Copied again.' });
    });

    await waitFor(() => {
      expect(screen.getByText('Copied again.')).toBeVisible();
    });
    expect(screen.queryByText('Copied once.')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('provides an internal link to the completed result', async () => {
    render(
      <MemoryRouter>
        <StudioToaster />
      </MemoryRouter>,
    );

    act(() => {
      studioToast.success({
        id: 'queued',
        message: 'Notification queued.',
        link: {
          label: 'View delivery history',
          to: '/newsletters?tab=deliveries&content_id=post-id',
        },
      });
    });

    expect(await screen.findByRole('link', {
      name: 'View delivery history',
    })).toHaveAttribute(
      'href',
      '/newsletters?tab=deliveries&content_id=post-id',
    );
  });

  it('removes the notification with the matching ID when explicitly dismissed', async () => {
    render(<StudioToaster />);
    act(() => {
      studioToast.success({ id: 'saved', message: 'Settings saved.' });
    });
    await waitFor(() => {
      expect(screen.getByText('Settings saved.')).toBeVisible();
    });

    act(() => studioToast.dismiss('saved'));
    await waitFor(() => {
      expect(screen.queryByText('Settings saved.')).not.toBeInTheDocument();
    });
  });
});
