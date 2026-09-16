import {
  dashboardSummaryResponseSchema,
  type DashboardSummary,
} from '../../../contracts/dashboard';

const DASHBOARD_TIMEOUT_MS = 15_000;

export type DashboardClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class DashboardClientError extends Error {
  constructor(public readonly code: DashboardClientErrorCode) {
    super(code);
    this.name = 'DashboardClientError';
  }
}

export async function requestDashboardSummary(
  signal?: AbortSignal,
): Promise<
  | { success: true; data: DashboardSummary }
  | { success: false; error: { code: string } }
> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    DASHBOARD_TIMEOUT_MS,
  );
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });

  try {
    const response = await studioFetch('/api/dashboard/summary', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      signal: controller.signal,
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new DashboardClientError('INVALID_RESPONSE');
    }
    const parsed = dashboardSummaryResponseSchema.safeParse(value);
    if (!parsed.success) throw new DashboardClientError('INVALID_RESPONSE');
    return parsed.data;
  } catch (error) {
    if (error instanceof DashboardClientError) throw error;
    if (controller.signal.aborted) throw new DashboardClientError('TIMEOUT');
    throw new DashboardClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
import { studioFetch } from './studio-fetch';
