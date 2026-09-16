import { z } from 'zod';
import { apiErrorSchema } from './api';
import {
  mfaEnrollmentProofSchema,
  mfaEnrollmentSetupResponseSchema,
  totpCodeSchema,
} from './mfa';
import {
  MAX_WEBAUTHN_CREDENTIALS,
  webAuthnAuthenticationOptionsSchema,
  webAuthnAuthenticationResponseSchema,
  webAuthnChallengeTokenSchema,
  webAuthnCredentialIdSchema,
  webAuthnCredentialNameSchema,
  webAuthnCredentialSummarySchema,
  webAuthnRegistrationOptionsSchema,
  webAuthnRegistrationResponseSchema,
} from './webauthn';

export const MFA_MANAGEMENT_FRESHNESS_SECONDS = 5 * 60;

export const mfaManagementOperationSchema = z.enum([
  'replace_totp',
  'add_webauthn',
  'remove_webauthn',
  'change_password',
  'invite_user',
  'reissue_user_invitation',
  'reset_user_access',
  'change_user_name',
  'change_user_role',
  'change_user_status',
  'cancel_user_invitation',
  'delete_user_account',
]);

export const mfaManagementTokenSchema = z.string()
  .min(32)
  .max(8192);

const mfaManagementTargetIdSchema = z.string()
  .regex(/^[0-9a-f]{32}$/u);

export const mfaManagementStatusSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    totp: z.object({
      configured_at_iso: z.iso.datetime({ offset: true }),
    }).strict(),
    webauthn: z.object({
      current_rp_id: z.string().trim().toLowerCase().min(1).max(253),
      max_credentials: z.literal(MAX_WEBAUTHN_CREDENTIALS),
      credentials: z.array(webAuthnCredentialSummarySchema)
        .max(MAX_WEBAUTHN_CREDENTIALS),
    }).strict(),
    step_up: z.object({
      mfa_required: z.boolean(),
      freshness_seconds: z.literal(MFA_MANAGEMENT_FRESHNESS_SECONDS),
    }).strict(),
  }).strict(),
}).strict();

export const mfaManagementStatusResponseSchema = z.union([
  mfaManagementStatusSuccessSchema,
  apiErrorSchema,
]);

export const mfaManagementVerificationSchema = z.discriminatedUnion(
  'method',
  [
    z.object({
      method: z.literal('totp'),
      code: totpCodeSchema,
    }).strict(),
  ],
);

function validateOperationTarget(
  value: {
    operation: z.infer<typeof mfaManagementOperationSchema>;
    target_id?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  const requiresTarget = value.operation === 'remove_webauthn'
    || value.operation === 'reissue_user_invitation'
    || value.operation === 'reset_user_access'
    || value.operation === 'change_user_name'
    || value.operation === 'change_user_role'
    || value.operation === 'change_user_status'
    || value.operation === 'cancel_user_invitation'
    || value.operation === 'delete_user_account';
  if (requiresTarget !== Boolean(value.target_id)) {
    context.addIssue({
      code: 'custom',
      path: ['target_id'],
      message: requiresTarget
        ? 'target_id is required for this operation.'
        : 'target_id is not allowed for this operation.',
    });
  }
}

export const authorizeMfaManagementRequestSchema = z.object({
  operation: mfaManagementOperationSchema,
  target_id: mfaManagementTargetIdSchema.optional(),
  password: z.string().min(1).max(1024),
  verification: mfaManagementVerificationSchema.optional(),
}).strict().superRefine(validateOperationTarget);

export const authorizeMfaManagementSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('authorized'),
    operation: mfaManagementOperationSchema,
    target_id: mfaManagementTargetIdSchema.optional(),
    management_token: mfaManagementTokenSchema,
    expires_at_iso: z.iso.datetime({ offset: true }),
  }).strict(),
}).strict();

export const authorizeMfaManagementResponseSchema = z.union([
  authorizeMfaManagementSuccessSchema,
  apiErrorSchema,
]);

export const mfaManagementWebAuthnStepUpOptionsRequestSchema = z.object({
  operation: mfaManagementOperationSchema,
  target_id: mfaManagementTargetIdSchema.optional(),
  password: z.string().min(1).max(1024),
}).strict().superRefine(validateOperationTarget);

export const mfaManagementWebAuthnStepUpOptionsSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    operation: mfaManagementOperationSchema,
    target_id: mfaManagementTargetIdSchema.optional(),
    options: webAuthnAuthenticationOptionsSchema,
    challenge_token: webAuthnChallengeTokenSchema,
    expires_at_iso: z.iso.datetime({ offset: true }),
  }).strict(),
}).strict();

export const mfaManagementWebAuthnStepUpOptionsResponseSchema = z.union([
  mfaManagementWebAuthnStepUpOptionsSuccessSchema,
  apiErrorSchema,
]);

export const mfaManagementWebAuthnStepUpVerifyRequestSchema = z.object({
  operation: mfaManagementOperationSchema,
  target_id: mfaManagementTargetIdSchema.optional(),
  challenge_token: webAuthnChallengeTokenSchema,
  response: webAuthnAuthenticationResponseSchema,
}).strict().superRefine(validateOperationTarget);

export const mfaManagementWebAuthnStepUpVerifyResponseSchema =
  authorizeMfaManagementResponseSchema;

export const mfaManagementTotpSetupRequestSchema = z.object({
  management_token: mfaManagementTokenSchema,
}).strict();

export const mfaManagementTotpSetupResponseSchema =
  mfaEnrollmentSetupResponseSchema;

export const mfaManagementTotpCompleteRequestSchema = z.object({
  management_token: mfaManagementTokenSchema,
  mfa: mfaEnrollmentProofSchema,
}).strict();

export const mfaManagementTotpCompleteSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('totp_replaced'),
    revoked_sessions: z.number().int().nonnegative().max(4),
  }).strict(),
}).strict();

export const mfaManagementTotpCompleteResponseSchema = z.union([
  mfaManagementTotpCompleteSuccessSchema,
  apiErrorSchema,
]);

export const mfaManagementWebAuthnRegistrationOptionsRequestSchema =
  z.object({
    management_token: mfaManagementTokenSchema,
  }).strict();

export const mfaManagementWebAuthnRegistrationOptionsSuccessSchema =
  z.object({
    success: z.literal(true),
    data: z.object({
      options: webAuthnRegistrationOptionsSchema,
      challenge_token: webAuthnChallengeTokenSchema,
      expires_at_iso: z.iso.datetime({ offset: true }),
    }).strict(),
  }).strict();

export const mfaManagementWebAuthnRegistrationOptionsResponseSchema =
  z.union([
    mfaManagementWebAuthnRegistrationOptionsSuccessSchema,
    apiErrorSchema,
  ]);

export const mfaManagementWebAuthnRegistrationCompleteRequestSchema =
  z.object({
    management_token: mfaManagementTokenSchema,
    challenge_token: webAuthnChallengeTokenSchema,
    display_name: webAuthnCredentialNameSchema,
    response: webAuthnRegistrationResponseSchema,
  }).strict();

export const mfaManagementWebAuthnRegistrationCompleteSuccessSchema =
  z.object({
    success: z.literal(true),
    data: z.object({
      status: z.literal('webauthn_registered'),
      credential: webAuthnCredentialSummarySchema,
    }).strict(),
  }).strict();

export const mfaManagementWebAuthnRegistrationCompleteResponseSchema =
  z.union([
    mfaManagementWebAuthnRegistrationCompleteSuccessSchema,
    apiErrorSchema,
  ]);

export const mfaManagementWebAuthnRenameRequestSchema = z.object({
  credential_id: webAuthnCredentialIdSchema,
  display_name: webAuthnCredentialNameSchema,
}).strict();

export const mfaManagementWebAuthnRenameSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('webauthn_renamed'),
    credential: webAuthnCredentialSummarySchema,
  }).strict(),
}).strict();

export const mfaManagementWebAuthnRenameResponseSchema = z.union([
  mfaManagementWebAuthnRenameSuccessSchema,
  apiErrorSchema,
]);

export const mfaManagementWebAuthnRemoveRequestSchema = z.object({
  credential_id: webAuthnCredentialIdSchema,
  management_token: mfaManagementTokenSchema,
}).strict();

export const mfaManagementWebAuthnRemoveSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('webauthn_removed'),
    revoked_sessions: z.number().int().nonnegative().max(4),
  }).strict(),
}).strict();

export const mfaManagementWebAuthnRemoveResponseSchema = z.union([
  mfaManagementWebAuthnRemoveSuccessSchema,
  apiErrorSchema,
]);

export type MfaManagementOperation = z.infer<
  typeof mfaManagementOperationSchema
>;
export type MfaManagementVerification = z.infer<
  typeof mfaManagementVerificationSchema
>;
export type MfaManagementStatusSuccess = z.infer<
  typeof mfaManagementStatusSuccessSchema
>;
export type MfaManagementStatusResponse = z.infer<
  typeof mfaManagementStatusResponseSchema
>;
export type AuthorizeMfaManagementRequest = z.infer<
  typeof authorizeMfaManagementRequestSchema
>;
export type AuthorizeMfaManagementResponse = z.infer<
  typeof authorizeMfaManagementResponseSchema
>;
export type MfaManagementWebAuthnStepUpOptionsRequest = z.infer<
  typeof mfaManagementWebAuthnStepUpOptionsRequestSchema
>;
export type MfaManagementWebAuthnStepUpOptionsResponse = z.infer<
  typeof mfaManagementWebAuthnStepUpOptionsResponseSchema
>;
export type MfaManagementWebAuthnStepUpVerifyRequest = z.infer<
  typeof mfaManagementWebAuthnStepUpVerifyRequestSchema
>;
export type MfaManagementWebAuthnStepUpVerifyResponse = z.infer<
  typeof mfaManagementWebAuthnStepUpVerifyResponseSchema
>;
export type MfaManagementTotpSetupRequest = z.infer<
  typeof mfaManagementTotpSetupRequestSchema
>;
export type MfaManagementTotpSetupResponse = z.infer<
  typeof mfaManagementTotpSetupResponseSchema
>;
export type MfaManagementTotpCompleteRequest = z.infer<
  typeof mfaManagementTotpCompleteRequestSchema
>;
export type MfaManagementTotpCompleteResponse = z.infer<
  typeof mfaManagementTotpCompleteResponseSchema
>;
export type MfaManagementWebAuthnRegistrationOptionsRequest = z.infer<
  typeof mfaManagementWebAuthnRegistrationOptionsRequestSchema
>;
export type MfaManagementWebAuthnRegistrationOptionsResponse = z.infer<
  typeof mfaManagementWebAuthnRegistrationOptionsResponseSchema
>;
export type MfaManagementWebAuthnRegistrationCompleteRequest = z.infer<
  typeof mfaManagementWebAuthnRegistrationCompleteRequestSchema
>;
export type MfaManagementWebAuthnRegistrationCompleteResponse = z.infer<
  typeof mfaManagementWebAuthnRegistrationCompleteResponseSchema
>;
export type MfaManagementWebAuthnRenameRequest = z.infer<
  typeof mfaManagementWebAuthnRenameRequestSchema
>;
export type MfaManagementWebAuthnRenameResponse = z.infer<
  typeof mfaManagementWebAuthnRenameResponseSchema
>;
export type MfaManagementWebAuthnRemoveRequest = z.infer<
  typeof mfaManagementWebAuthnRemoveRequestSchema
>;
export type MfaManagementWebAuthnRemoveResponse = z.infer<
  typeof mfaManagementWebAuthnRemoveResponseSchema
>;
