import { z } from 'zod';
import { apiErrorSchema } from '../../../contracts/api';
import { auditLogListSuccessSchema, auditLogDetailSuccessSchema, type AuditLogQuery } from '../../../contracts/audit-logs';
import { studioFetch } from './studio-fetch';
async function request<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
  const response = await studioFetch(path, { credentials: 'same-origin', cache: 'no-store',
    headers: { Accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  return schema.parse(await response.json());
}
export function requestAuditLogs(query: AuditLogQuery, signal: AbortSignal) {
  const params = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => Boolean(entry[1])));
  return request(`/api/audit-logs?${params}`, z.union([auditLogListSuccessSchema, apiErrorSchema]), signal);
}
export function requestAuditLog(id: string, signal: AbortSignal) {
  return request(`/api/audit-logs/${encodeURIComponent(id)}`, z.union([auditLogDetailSuccessSchema, apiErrorSchema]), signal);
}
