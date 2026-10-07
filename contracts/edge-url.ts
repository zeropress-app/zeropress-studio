import { z } from 'zod';
import { apiErrorSchema } from './api';
import { normalizeSiteOrigin } from './general-settings';
import { SETTINGS_INITIAL_REVISION, settingsRevisionSchema } from './settings-revision';

export const EDGE_URL_SETTINGS_INITIAL_REVISION = SETTINGS_INITIAL_REVISION;

/** Public Edge routes are rooted at /api; local development may use a loopback port. */
export function normalizeEdgeOrigin(value: string): string | null {
  const origin = normalizeSiteOrigin(value.trim());
  if (origin === null || origin === '') return origin;
  const url = new URL(origin);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return (url.protocol === 'https:' && url.port === '') || loopback ? origin : null;
}

const inputOrigin = z.string().max(2048).transform((value, context) => {
  const origin = normalizeEdgeOrigin(value);
  if (origin === null) {
    context.addIssue({ code: 'custom', message: 'Enter an HTTPS origin without a path or custom port.' });
    return z.NEVER;
  }
  return origin;
});
export const edgeUrlSettingsInputSchema = z.object({ edge_origin: inputOrigin }).strict();
export const edgeUrlSettingsSchema = z.object({
  edge_origin: z.string().max(2048).refine((value) => normalizeEdgeOrigin(value) === value),
}).strict();
export type EdgeUrlSettings = z.infer<typeof edgeUrlSettingsSchema>;
export function materializeEdgeUrlSettingsDefaults(): EdgeUrlSettings { return { edge_origin: '' }; }
export const updateEdgeUrlSettingsRequestSchema = z.object({
  settings: edgeUrlSettingsInputSchema,
  expected_revision: settingsRevisionSchema,
}).strict();
export const edgeUrlSettingsDocumentSchema = z.object({
  settings: edgeUrlSettingsSchema,
  revision: settingsRevisionSchema,
  updated_at_iso: z.iso.datetime({ offset: true }).nullable(),
}).strict();
export const edgeUrlSettingsSuccessSchema = z.object({ success: z.literal(true), data: edgeUrlSettingsDocumentSchema }).strict();
export const edgeUrlSettingsResponseSchema = z.union([edgeUrlSettingsSuccessSchema, apiErrorSchema]);
export type EdgeUrlSettingsSuccess = z.infer<typeof edgeUrlSettingsSuccessSchema>;
export type EdgeUrlSettingsResponse = z.infer<typeof edgeUrlSettingsResponseSchema>;
export type UpdateEdgeUrlSettingsRequest = z.input<typeof updateEdgeUrlSettingsRequestSchema>;

export function edgeEndpoint(origin: string, kind: 'comments' | 'form' | 'newsletter', slug?: string): string | null {
  if (!origin || normalizeEdgeOrigin(origin) !== origin) return null;
  if (kind === 'comments') return `${origin}/api`;
  if (!slug) return null;
  return `${origin}/api/${kind === 'form' ? 'forms' : 'newsletters'}/${encodeURIComponent(slug)}`;
}
