import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

type Changes = Record<string, string | number | null>;

function mergeQuery(current: URLSearchParams, changes: Changes): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(changes)) {
    if (
      value === null || value === ''
      || ((key === 'status' || key === 'target_type') && value === 'all')
      || (key === 'page' && value === 1)
    ) next.delete(key);
    else next.set(key, String(value));
  }
  return next;
}

/** Committed list filters live in the URL; unfinished input and selection stay local. */
export function useListQuery<Status extends string>(statuses: readonly Status[]) {
  const [params, setParams] = useSearchParams();
  const requestedStatus = params.get('status');
  const status: Status | 'all' = statuses.find((value) => value === requestedStatus) ?? 'all';
  const requestedPage = Number(params.get('page'));
  const page = Number.isSafeInteger(requestedPage) && requestedPage >= 1 && requestedPage <= 1_000_000
    ? requestedPage : 1;
  const search = (params.get('search') ?? '').trim().slice(0, 200);
  const queryKey = params.toString();
  const updateQuery = useCallback((changes: Changes, replace = false) => {
    setParams((current) => mergeQuery(current, changes), { replace });
  }, [setParams]);
  function statusHref(value: Status | 'all') {
    const next = mergeQuery(params, { status: value, page: 1 });
    return `?${next.toString()}`;
  }
  return { params, queryKey, status, search, page, updateQuery, statusHref };
}
