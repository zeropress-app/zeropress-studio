import { z } from 'zod';

export const AUDIT_CATEGORIES = ['auth', 'account', 'content', 'publishing', 'settings', 'import', 'operations'] as const;
export const AUDIT_OUTCOMES = ['success', 'failed', 'partial', 'unchanged', 'unknown'] as const;
export const AUDIT_ACTIONS = {
  auth_login: 'auth', auth_logout: 'auth', auth_reauthenticate: 'auth',
  account_invite: 'account', account_reinvite: 'account', account_cancel_invitation: 'account',
  account_activate: 'account', account_delete: 'account', account_recover: 'account',
  account_role: 'account', account_status: 'account', account_password: 'account',
  account_totp: 'account', account_passkey_add: 'account', account_passkey_remove: 'account',
  account_revoke_sessions: 'account',
  content_status: 'content', content_trash: 'content', content_restore: 'content',
  content_delete: 'content', content_bulk: 'content', media_delete: 'content',
  publishing_publish: 'publishing', settings_update: 'settings',
  import_chunk: 'import', import_settings: 'import',
  operations_upgrade: 'operations', operations_backup: 'operations', operations_restore: 'operations',
  operations_recover_administrator: 'operations', operations_clear: 'operations', operations_reset: 'operations',
  operations_edge: 'operations', operations_reconcile: 'operations', operations_search: 'operations',
  operations_access: 'operations',
} as const;
export type AuditAction = keyof typeof AUDIT_ACTIONS;
export type AuditOutcome = typeof AUDIT_OUTCOMES[number];
const text = z.string().max(512);
export const auditActorSchema = z.object({
  kind: z.enum(['user', 'operations']), id: text.nullable(), name: text.nullable(), email: text.nullable(),
});
export type AuditActor = z.infer<typeof auditActorSchema>;
const count = z.number().int().nonnegative();
// Only these structured summaries may cross the audit boundary. Never pass request bodies here.
export const auditMetadataSchema = z.object({
  method: z.enum(['totp', 'passkey', 'password']).optional(),
  operation_id: text.optional(), stage: z.enum(['started', 'step', 'completed', 'cancelled']).optional(),
  operation: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/).optional(),
  initiator: auditActorSchema.optional(),
  fields: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/)).max(100).optional(),
  credential: z.enum(['retained', 'replaced', 'removed']).optional(),
  credentials: z.array(z.object({ field: z.enum(['resend_api_key', 'cloudflare_api_token']), action: z.enum(['replace', 'remove']) })).max(2).optional(),
  phase: z.enum(['authors', 'categories', 'tags', 'media', 'posts', 'pages', 'menus', 'comments']).optional(),
  roles: z.array(z.enum(['admin', 'editor', 'author'])).max(3).optional(),
  from_status: z.string().max(40).optional(), to_status: z.string().max(40).optional(),
  requested: count.optional(), succeeded: count.optional(), failed: count.optional(), skipped: count.optional(),
  created: count.optional(), updated: count.optional(), deleted: count.optional(),
  error_code: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/).optional(),
  commit_sha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
});
export type AuditMetadata = z.infer<typeof auditMetadataSchema>;

const COUNTS = ['requested', 'succeeded', 'failed', 'skipped', 'created', 'updated', 'deleted'] as const;
const OPERATION_FIELDS = ['operation_id', 'stage', 'operation', 'initiator', ...COUNTS] as const;
const ACTION_METADATA_FIELDS = {
  auth_login: ['method'],
  auth_logout: [],
  auth_reauthenticate: ['method'],
  account_invite: [],
  account_reinvite: [],
  account_cancel_invitation: [],
  account_activate: [],
  account_delete: [],
  account_recover: ['deleted'],
  account_role: ['roles', 'deleted'],
  account_status: ['from_status', 'to_status', 'deleted'],
  account_password: ['deleted'],
  account_totp: ['deleted'],
  account_passkey_add: [],
  account_passkey_remove: ['deleted'],
  account_revoke_sessions: ['deleted'],
  content_status: ['from_status', 'to_status'],
  content_trash: ['from_status', 'to_status'],
  content_restore: ['from_status', 'to_status'],
  content_delete: [],
  content_bulk: [...COUNTS, 'to_status'],
  media_delete: COUNTS,
  publishing_publish: ['commit_sha'],
  settings_update: ['fields', 'credential', 'credentials'],
  import_chunk: ['phase', ...COUNTS],
  import_settings: ['fields'],
  operations_upgrade: OPERATION_FIELDS,
  operations_backup: OPERATION_FIELDS,
  operations_restore: OPERATION_FIELDS,
  operations_recover_administrator: OPERATION_FIELDS,
  operations_clear: OPERATION_FIELDS,
  operations_reset: OPERATION_FIELDS,
  operations_edge: OPERATION_FIELDS,
  operations_reconcile: OPERATION_FIELDS,
  operations_search: OPERATION_FIELDS,
  operations_access: OPERATION_FIELDS,
} satisfies Record<AuditAction, readonly (keyof AuditMetadata)[]>;

export function parseAuditMetadata(action: AuditAction, input: unknown): AuditMetadata {
  const parsed = auditMetadataSchema.parse(input);
  const allowed: readonly string[] = [...ACTION_METADATA_FIELDS[action], 'error_code'];
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => allowed.includes(key)));
}

export const auditLogSchema = z.object({
  id: z.string(), occurred_at: z.string(), action: z.enum(Object.keys(AUDIT_ACTIONS) as [AuditAction, ...AuditAction[]]),
  category: z.enum(AUDIT_CATEGORIES), outcome: z.enum(AUDIT_OUTCOMES),
  actor: auditActorSchema,
  target: z.object({ type: text, id: z.string().max(4096).nullable(), label: text.nullable() }),
  metadata: auditMetadataSchema,
});
export const auditNetworkSchema = z.object({
  ip_address: text.nullable(), ip_recorded_at: text.nullable(), ip_hash: text.nullable(),
  user_agent: z.string().max(1024).nullable(), country: text.nullable(), region: text.nullable(),
  city: text.nullable(), timezone: text.nullable(), asn: z.number().int().positive().nullable(), organization: text.nullable(),
});
export const auditLogDetailSchema = auditLogSchema.extend({ network: auditNetworkSchema });
export type AuditLog = z.infer<typeof auditLogSchema>;
export type AuditLogDetail = z.infer<typeof auditLogDetailSchema>;
export const auditLogListSuccessSchema = z.object({ success: z.literal(true), data: z.object({
  items: z.array(auditLogSchema), next_cursor: z.string().nullable(),
}) });
export const auditLogDetailSuccessSchema = z.object({ success: z.literal(true), data: auditLogDetailSchema });
export const auditLogQuerySchema = z.object({
  from: z.iso.datetime().transform((value) => new Date(value).toISOString()).optional(),
  to: z.iso.datetime().transform((value) => new Date(value).toISOString()).optional(),
  actor: z.string().trim().max(200).optional(), category: z.enum(AUDIT_CATEGORIES).optional(),
  outcome: z.enum(AUDIT_OUTCOMES).optional(), ip_hash: z.string().regex(/^v1\.[a-f0-9]{64}$/).optional(),
  cursor: z.string().max(2048).optional(),
}).refine((v) => !v.from || !v.to || v.from <= v.to);
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;
export const AUDIT_RETENTION_DAYS = 365;
export const AUDIT_IP_RETENTION_DAYS = 30;
