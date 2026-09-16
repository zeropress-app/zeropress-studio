import { apiErrorSchema } from '../../../contracts/api';

export type StudioAccessInterruption =
  | 'outer_session_required'
  | 'requirement_not_satisfied'
  | 'verification_unavailable';

type StudioAccessInterruptionListener = (
  interruption: StudioAccessInterruption,
) => void;

const listeners = new Set<StudioAccessInterruptionListener>();

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get('Content-Type')
    ?.split(';')[0]?.trim().toLowerCase();
  return contentType === 'application/json'
    || contentType?.endsWith('+json') === true;
}

function publish(interruption: StudioAccessInterruption): void {
  for (const listener of listeners) listener(interruption);
}

async function inspectStudioAccessBoundary(response: Response): Promise<void> {
  if (response.status === 401 && !isJsonResponse(response)) {
    publish('outer_session_required');
    return;
  }
  if (
    (response.status !== 403 && response.status !== 503)
    || !isJsonResponse(response)
  ) return;

  let raw: unknown;
  try {
    raw = await response.clone().json();
  } catch {
    return;
  }
  const parsed = apiErrorSchema.safeParse(raw);
  if (!parsed.success) return;
  if (parsed.data.error.code === 'CLOUDFLARE_ACCESS_REQUIRED') {
    publish('requirement_not_satisfied');
  } else if (
    parsed.data.error.code === 'CLOUDFLARE_ACCESS_VERIFICATION_UNAVAILABLE'
  ) {
    publish('verification_unavailable');
  }
}

/**
 * Browser requests to Studio's same-origin API boundary share these transport
 * defaults. `X-Requested-With` asks an outer Cloudflare Access deployment to
 * return a machine-readable 401 instead of an HTML sign-in redirect when its
 * session expires; Studio JSON 401 responses remain ordinary API responses.
 */
export async function studioFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = init.headers instanceof Headers
    || Array.isArray(init.headers)
    ? (() => {
        const result = new Headers(init.headers);
        result.set('X-Requested-With', 'XMLHttpRequest');
        return result;
      })()
    : {
        ...Object.fromEntries(Object.entries(init.headers ?? {}).filter(
          ([name]) => name.toLowerCase() !== 'x-requested-with',
        )),
        'X-Requested-With': 'XMLHttpRequest',
      };
  const response = await fetch(input, {
    ...init,
    headers,
    credentials: init.credentials ?? 'same-origin',
  });
  await inspectStudioAccessBoundary(response);
  return response;
}

export function subscribeStudioAccessInterruption(
  listener: StudioAccessInterruptionListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetStudioAccessInterruptionListenersForTests(): void {
  listeners.clear();
}
