import { z } from 'zod';
import { apiErrorSchema } from './api';
import { edgeDatabaseRuntimeStateSchema } from './edge-runtime';
import {
  normalizeSiteOrigin,
  normalizeSiteTitle,
} from './general-settings';
import {
  externalMediaUrlSchema,
  privateMediaPreviewUrlSchema,
} from './media';

const opaqueIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);
const roleKeySchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9._-]+$/u);
const siteUrlSchema = z.string().min(1).max(2_048).refine(
  (value) => normalizeSiteOrigin(value) === value,
  'Expected a canonical HTTP(S) site origin',
);
const siteTitleSchema = z.string().refine(
  (value) => normalizeSiteTitle(value) === value,
  'Expected a canonical non-empty site title',
);

export const edgeIntegrationModeSchema = z.enum(['enabled', 'disabled']);

export const authenticatedUserSchema = z.object({
  id: opaqueIdSchema,
  email: z.email().max(254),
  name: z.string().min(2).max(100),
  roles: z.array(roleKeySchema).max(32),
  avatar_preview_url: z.union([
    externalMediaUrlSchema,
    privateMediaPreviewUrlSchema,
  ]).optional(),
}).strict();

export const currentSessionNetworkSchema = z.object({
  ip_address: z.string().min(1).max(64),
  asn: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  as_organization: z.string().trim().min(1).max(255).nullable(),
  country_code: z.string().regex(/^[A-Z0-9]{2,8}$/u).nullable(),
}).strict();

export const currentSessionSchema = z.object({
  id: opaqueIdSchema,
  created_at_iso: z.iso.datetime({ offset: true }),
  last_seen_at_iso: z.iso.datetime({ offset: true }),
  idle_expires_at_iso: z.iso.datetime({ offset: true }),
  absolute_expires_at_iso: z.iso.datetime({ offset: true }),
  network: currentSessionNetworkSchema,
}).strict();

export const sessionListItemSchema = z.object({
  id: opaqueIdSchema,
  is_current: z.boolean(),
  created_at_iso: z.iso.datetime({ offset: true }),
  last_seen_at_iso: z.iso.datetime({ offset: true }),
  idle_expires_at_iso: z.iso.datetime({ offset: true }),
  absolute_expires_at_iso: z.iso.datetime({ offset: true }),
  user_agent: z.string().trim().min(1).max(1024).nullable(),
  network: currentSessionNetworkSchema,
}).strict();

export const currentSessionSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    user: authenticatedUserSchema,
    session: currentSessionSchema,
    csrf_token: z.string().min(32).max(128),
    edge_integration: z.object({
      mode: edgeIntegrationModeSchema,
      // Disabled integration deliberately skips EDGE_DB and returns null.
      database_state: edgeDatabaseRuntimeStateSchema.nullable(),
    }).strict(),
    // Omitted when the stored presentation setting is missing or malformed.
    site_title: siteTitleSchema.optional(),
    // Omitted until a canonical site URL has been configured.
    site_url: siteUrlSchema.optional(),
  }).strict(),
}).strict();

export const currentSessionResponseSchema = z.union([
  currentSessionSuccessSchema,
  apiErrorSchema,
]);

export const sessionListSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(sessionListItemSchema).max(5),
    max_sessions: z.literal(5),
  }).strict(),
}).strict();

export const sessionListResponseSchema = z.union([
  sessionListSuccessSchema,
  apiErrorSchema,
]);

export const revokeSessionRequestSchema = z.object({
  session_id: opaqueIdSchema,
}).strict();

export const revokeSessionSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('session_revoked'),
    revoked: z.boolean(),
    current_session_ended: z.boolean(),
  }).strict(),
}).strict();

export const revokeSessionResponseSchema = z.union([
  revokeSessionSuccessSchema,
  apiErrorSchema,
]);

export const revokeOtherSessionsRequestSchema = z.object({}).strict();

export const revokeOtherSessionsSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('other_sessions_revoked'),
    revoked_count: z.number().int().nonnegative().max(4),
  }).strict(),
}).strict();

export const revokeOtherSessionsResponseSchema = z.union([
  revokeOtherSessionsSuccessSchema,
  apiErrorSchema,
]);

export const logoutRequestSchema = z.object({}).strict();

export const logoutSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('logged_out'),
  }).strict(),
}).strict();

export const logoutResponseSchema = z.union([
  logoutSuccessSchema,
  apiErrorSchema,
]);

export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>;
export type EdgeIntegrationMode = z.infer<
  typeof edgeIntegrationModeSchema
>;
export type CurrentSession = z.infer<typeof currentSessionSchema>;
export type SessionListItem = z.infer<typeof sessionListItemSchema>;
export type CurrentSessionSuccess = z.infer<
  typeof currentSessionSuccessSchema
>;
export type CurrentSessionResponse = z.infer<
  typeof currentSessionResponseSchema
>;
export type SessionListSuccess = z.infer<typeof sessionListSuccessSchema>;
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;
export type RevokeSessionRequest = z.infer<
  typeof revokeSessionRequestSchema
>;
export type RevokeSessionSuccess = z.infer<
  typeof revokeSessionSuccessSchema
>;
export type RevokeSessionResponse = z.infer<
  typeof revokeSessionResponseSchema
>;
export type RevokeOtherSessionsSuccess = z.infer<
  typeof revokeOtherSessionsSuccessSchema
>;
export type RevokeOtherSessionsResponse = z.infer<
  typeof revokeOtherSessionsResponseSchema
>;
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;
export type LogoutSuccess = z.infer<typeof logoutSuccessSchema>;
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;
