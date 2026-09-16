import { z } from 'zod';
import { apiErrorSchema } from './api';
import { publicAuthorIdentitySchema } from './author-identity';
import {
  mfaEnrollmentProofSchema,
  mfaEnrollmentSetupResponseSchema,
} from './mfa';
import { mfaManagementTokenSchema } from './mfa-management';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from './password-policy';

export const SYSTEM_ROLE_KEYS = ['admin', 'editor', 'author'] as const;
export const USERS_DEFAULT_PAGE_SIZE = 50;
export const USERS_MAX_PAGE_SIZE = 100;
export const userRoleSchema = z.enum(SYSTEM_ROLE_KEYS);
export const userStatusSchema = z.enum([
  'pending',
  'active',
  'inactive',
]);
export const userIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);
export const USER_SETUP_PURPOSES = [
  'invitation',
  'credential_recovery',
] as const;
export const userSetupPurposeSchema = z.enum(USER_SETUP_PURPOSES);
export const userSetupTokenSchema = z.string()
  .regex(/^[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/u);

const userNameSchema = z.string().trim().min(2).max(100);
const userEmailSchema = z.string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254));

export const managedUserSchema = z.object({
  id: userIdSchema,
  email: userEmailSchema,
  name: userNameSchema,
  status: userStatusSchema,
  role: userRoleSchema,
  mfa: z.object({
    totp_configured: z.boolean(),
    webauthn_credentials: z.number().int().nonnegative().max(10),
  }).strict(),
  active_sessions: z.number().int().nonnegative().max(5),
  author: publicAuthorIdentitySchema.nullable(),
  setup: z.object({
    purpose: userSetupPurposeSchema,
    status: z.enum(['pending', 'expired']),
    expires_at_iso: z.iso.datetime({ offset: true }),
  }).strict().nullable(),
  created_at_iso: z.iso.datetime({ offset: true }),
  updated_at_iso: z.iso.datetime({ offset: true }),
}).strict();

export const userListQuerySchema = z.object({
  search: z.string().trim().max(200).default(''),
  role: z.enum(['all', ...SYSTEM_ROLE_KEYS]).default('all'),
  status: z.enum(['all', 'pending', 'active', 'inactive']).default('all'),
  page: z.coerce.number().int().positive().max(1_000_000).default(1),
  per_page: z.coerce.number().int().positive()
    .max(USERS_MAX_PAGE_SIZE)
    .default(USERS_DEFAULT_PAGE_SIZE),
}).strict();

const userPaginationSchema = z.object({
  page: z.number().int().positive(),
  per_page: z.number().int().positive().max(USERS_MAX_PAGE_SIZE),
  total: z.number().int().nonnegative(),
  total_pages: z.number().int().nonnegative(),
}).strict();

const userStatusCountsSchema = z.object({
  all: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  inactive: z.number().int().nonnegative(),
}).strict();

export const userListSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  inactive: z.number().int().nonnegative(),
  administrators: z.number().int().nonnegative(),
}).strict().refine(
  (summary) => summary.total
    === summary.active + summary.pending + summary.inactive,
  { message: 'User summary status counts must equal total.' },
);

export const userListSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(managedUserSchema).max(USERS_MAX_PAGE_SIZE),
    pagination: userPaginationSchema,
    status_counts: userStatusCountsSchema,
    summary: userListSummarySchema,
  }).strict(),
}).strict();

export const userListResponseSchema = z.union([
  userListSuccessSchema,
  apiErrorSchema,
]);

export const createUserInvitationRequestSchema = z.object({
  email: userEmailSchema,
  name: userNameSchema,
  role: userRoleSchema,
  management_token: mfaManagementTokenSchema,
}).strict();

export const reissueUserInvitationRequestSchema = z.object({
  user_id: userIdSchema,
  management_token: mfaManagementTokenSchema,
}).strict();

export const resetUserAccessRequestSchema = z.object({
  user_id: userIdSchema,
  management_token: mfaManagementTokenSchema,
}).strict();

export const updateUserNameRequestSchema = z.object({
  user_id: userIdSchema,
  name: userNameSchema,
  expected_updated_at_iso: z.iso.datetime({ offset: true }),
  management_token: mfaManagementTokenSchema,
}).strict();

const userSetupIssuedDataSchema = z.object({
  status: z.enum([
    'invitation_created',
    'invitation_reissued',
    'credential_recovery_created',
    'credential_recovery_reissued',
  ]),
  user: managedUserSchema,
  setup_url: z.url().max(16_384),
  expires_at_iso: z.iso.datetime({ offset: true }),
}).strict();

export const userSetupIssuedSuccessSchema = z.object({
  success: z.literal(true),
  data: userSetupIssuedDataSchema,
}).strict();

export const userSetupIssuedResponseSchema = z.union([
  userSetupIssuedSuccessSchema,
  apiErrorSchema,
]);

export const updateUserRoleRequestSchema = z.object({
  user_id: userIdSchema,
  role: userRoleSchema,
  management_token: mfaManagementTokenSchema,
}).strict();

export const updateUserStatusRequestSchema = z.object({
  user_id: userIdSchema,
  status: z.enum(['active', 'inactive']),
  management_token: mfaManagementTokenSchema,
}).strict();

export const inspectUserDeletionImpactRequestSchema = z.object({
  user_id: userIdSchema,
}).strict();

export const userDeletionImpactSchema = z.object({
  operation: z.enum(['cancel_invitation', 'delete_account']),
  user: managedUserSchema,
  effects: z.object({
    post_autosaves: z.number().int().nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    page_autosaves: z.number().int().nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    media_upload_intents: z.number().int().nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
  }).strict(),
}).strict();

export const userDeletionImpactSuccessSchema = z.object({
  success: z.literal(true),
  data: userDeletionImpactSchema,
}).strict();

export const userDeletionImpactResponseSchema = z.union([
  userDeletionImpactSuccessSchema,
  apiErrorSchema,
]);

const destructiveUserMutationBaseSchema = z.object({
  user_id: userIdSchema,
  confirmation_email: userEmailSchema,
  management_token: mfaManagementTokenSchema,
}).strict();

export const cancelUserInvitationRequestSchema =
  destructiveUserMutationBaseSchema;

export const deleteUserAccountRequestSchema = z.object({
  user_id: userIdSchema,
  confirmation_email: userEmailSchema,
  acknowledge_recovery_copy_deletion: z.literal(true),
  management_token: mfaManagementTokenSchema,
}).strict();

export const destructiveUserMutationSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.enum(['invitation_cancelled', 'user_account_deleted']),
    user_id: userIdSchema,
  }).strict(),
}).strict();

export const destructiveUserMutationResponseSchema = z.union([
  destructiveUserMutationSuccessSchema,
  apiErrorSchema,
]);

const userMutationResultDataSchema = z.object({
  status: z.enum([
    'user_name_updated',
    'user_role_updated',
    'user_status_updated',
  ]),
  user: managedUserSchema,
  revoked_sessions: z.number().int().nonnegative().max(5),
  current_session_ended: z.boolean(),
}).strict();

export const userMutationSuccessSchema = z.object({
  success: z.literal(true),
  data: userMutationResultDataSchema,
}).strict();

export const userMutationResponseSchema = z.union([
  userMutationSuccessSchema,
  apiErrorSchema,
]);

export const inspectUserSetupRequestSchema = z.object({
  setup_token: userSetupTokenSchema,
}).strict();

export const inspectUserSetupSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    purpose: userSetupPurposeSchema,
    email: userEmailSchema,
    name: userNameSchema,
    role: userRoleSchema,
    expires_at_iso: z.iso.datetime({ offset: true }),
  }).strict(),
}).strict();

export const inspectUserSetupResponseSchema = z.union([
  inspectUserSetupSuccessSchema,
  apiErrorSchema,
]);

export const prepareUserSetupRequestSchema = z.object({
  setup_token: userSetupTokenSchema,
  password: z.string()
    .min(PASSWORD_MIN_LENGTH)
    .max(PASSWORD_MAX_LENGTH),
}).strict();

export const prepareUserSetupResponseSchema =
  mfaEnrollmentSetupResponseSchema;

export const completeUserSetupRequestSchema = z.object({
  mfa: mfaEnrollmentProofSchema,
}).strict();

export const completeUserSetupSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('user_activated'),
  }).strict(),
}).strict();

export const completeUserSetupResponseSchema = z.union([
  completeUserSetupSuccessSchema,
  apiErrorSchema,
]);

export type UserRole = z.infer<typeof userRoleSchema>;
export type UserStatus = z.infer<typeof userStatusSchema>;
export type UserSetupPurpose = z.infer<typeof userSetupPurposeSchema>;
export type ManagedUser = z.infer<typeof managedUserSchema>;
export type UserListQuery = z.infer<typeof userListQuerySchema>;
export type UserListSummary = z.infer<typeof userListSummarySchema>;
export type UserListData = z.infer<typeof userListSuccessSchema>['data'];
export type UserListResponse = z.infer<typeof userListResponseSchema>;
export type CreateUserInvitationRequest = z.infer<
  typeof createUserInvitationRequestSchema
>;
export type ReissueUserInvitationRequest = z.infer<
  typeof reissueUserInvitationRequestSchema
>;
export type ResetUserAccessRequest = z.infer<
  typeof resetUserAccessRequestSchema
>;
export type UpdateUserNameRequest = z.infer<
  typeof updateUserNameRequestSchema
>;
export type UserSetupIssuedResponse = z.infer<
  typeof userSetupIssuedResponseSchema
>;
export type UpdateUserRoleRequest = z.infer<
  typeof updateUserRoleRequestSchema
>;
export type UpdateUserStatusRequest = z.infer<
  typeof updateUserStatusRequestSchema
>;
export type InspectUserDeletionImpactRequest = z.infer<
  typeof inspectUserDeletionImpactRequestSchema
>;
export type UserDeletionImpact = z.infer<typeof userDeletionImpactSchema>;
export type UserDeletionImpactResponse = z.infer<
  typeof userDeletionImpactResponseSchema
>;
export type CancelUserInvitationRequest = z.infer<
  typeof cancelUserInvitationRequestSchema
>;
export type DeleteUserAccountRequest = z.infer<
  typeof deleteUserAccountRequestSchema
>;
export type DestructiveUserMutationResponse = z.infer<
  typeof destructiveUserMutationResponseSchema
>;
export type UserMutationResponse = z.infer<
  typeof userMutationResponseSchema
>;
export type InspectUserSetupRequest = z.infer<
  typeof inspectUserSetupRequestSchema
>;
export type InspectUserSetupResponse = z.infer<
  typeof inspectUserSetupResponseSchema
>;
export type PrepareUserSetupRequest = z.infer<
  typeof prepareUserSetupRequestSchema
>;
export type PrepareUserSetupResponse = z.infer<
  typeof prepareUserSetupResponseSchema
>;
export type CompleteUserSetupRequest = z.infer<
  typeof completeUserSetupRequestSchema
>;
export type CompleteUserSetupResponse = z.infer<
  typeof completeUserSetupResponseSchema
>;
