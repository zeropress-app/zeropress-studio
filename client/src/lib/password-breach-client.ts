import {
  passwordBreachCheckResponseSchema,
  type PasswordBreachAssessment,
} from '../../../contracts/password-breach';

const PASSWORD_BREACH_CHECK_TIMEOUT_MS = 4_000;

export async function requestPasswordBreachCheck(
  password: string,
  signal?: AbortSignal,
): Promise<PasswordBreachAssessment> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener('abort', abortFromCaller, { once: true });
  }
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    PASSWORD_BREACH_CHECK_TIMEOUT_MS,
  );

  try {
    const response = await studioFetch('/api/auth/password/check', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password }),
      credentials: 'same-origin',
      signal: controller.signal,
    });
    const parsed = passwordBreachCheckResponseSchema.safeParse(
      await response.json(),
    );
    if (!parsed.success || !parsed.data.success) {
      throw new Error('PASSWORD_BREACH_CHECK_UNAVAILABLE');
    }
    return parsed.data.data;
  } finally {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}
import { studioFetch } from './studio-fetch';
