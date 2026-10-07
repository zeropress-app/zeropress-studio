import { z } from 'zod';
import { apiErrorSchema } from './api';
import { settingsRevisionSchema } from './settings-revision';
import { passkeySnapshotSchema } from './passkey-metadata';

export const passkeySettingsSchema = z.object({ require_fido_certified_authenticator: z.boolean() }).strict();
export const DEFAULT_PASSKEY_SETTINGS = { require_fido_certified_authenticator: false } as const;
export const passkeySettingsDocumentSchema = z.object({
  settings: passkeySettingsSchema,
  revision: settingsRevisionSchema,
  updated_at_iso: z.iso.datetime().nullable(),
  snapshot: passkeySnapshotSchema,
}).strict();
export const updatePasskeySettingsRequestSchema = z.object({
  settings: passkeySettingsSchema,
  expected_revision: settingsRevisionSchema,
  management_token: z.string().min(32).max(8192),
}).strict();
export const passkeySettingsSuccessSchema = z.object({ success: z.literal(true), data: passkeySettingsDocumentSchema }).strict();
export const passkeySettingsResponseSchema = z.union([passkeySettingsSuccessSchema, apiErrorSchema]);
export type PasskeySettings = z.infer<typeof passkeySettingsSchema>;
export type PasskeySettingsDocument = z.infer<typeof passkeySettingsDocumentSchema>;
export type PasskeySettingsResponse = z.infer<typeof passkeySettingsResponseSchema>;
export type UpdatePasskeySettingsRequest = z.infer<typeof updatePasskeySettingsRequestSchema>;
