import { z } from 'zod';
import { apiErrorSchema } from './api';
import {
  SETTINGS_INITIAL_REVISION,
  settingsRevisionSchema,
} from './settings-revision';

export const PUBLISHING_INITIAL_REVISION = SETTINGS_INITIAL_REVISION;
export const PUBLISHING_DEFAULTS = {
  enabled: false,
  owner: '',
  repo: '',
  branch: '',
  path: '',
} as const;

const owner = z
  .string()
  .trim()
  .toLowerCase()
  .max(39)
  .regex(/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?)?$/u);
const repo = z
  .string()
  .trim()
  .max(100)
  .regex(/^[A-Za-z\d._-]*$/u)
  .refine((value) => !['.', '..'].includes(value));
export function validPublishingBranch(value: string): boolean {
  return (
    value.length <= 255 &&
    value !== 'HEAD' &&
    !/^[a-f\d]{40}(?:[a-f\d]{24})?$/iu.test(value) &&
    !/[\s\p{Cc}~^:?*\[\\]/u.test(value) &&
    !value.includes('..') &&
    !value.includes('@{') &&
    value !== '@' &&
    value
      .split('/')
      .every(
        (part) =>
          Boolean(part) &&
          !part.startsWith('.') &&
          !part.endsWith('.') &&
          !part.endsWith('.lock'),
      )
  );
}
export function validPublishingPath(value: string): boolean {
  return (
    value.length <= 1024 &&
    /\.json$/iu.test(value) &&
    !/[\p{Cc}\\]/u.test(value) &&
    value
      .split('/')
      .every((part) => Boolean(part) && !['.', '..', '.git'].includes(part))
  );
}
const branch = z
  .string()
  .trim()
  .refine((value) => !value || validPublishingBranch(value));
const path = z
  .string()
  .trim()
  .refine((value) => !value || validPublishingPath(value));
const fields = { owner, repo, branch, path };
export const publishingTargetSchema = z
  .object({
    owner: owner.refine(Boolean),
    repo: repo.refine(Boolean),
    branch: branch.refine(Boolean),
    path: path.refine(Boolean),
  })
  .strict();
export const publishingSettingsSchema = z
  .object({ enabled: z.boolean(), ...fields })
  .strict()
  .refine(
    (value) =>
      !value.enabled ||
      publishingTargetSchema.safeParse(targetFromSettings(value)).success,
  );
export function targetFromSettings(value: PublishingTarget): PublishingTarget {
  return {
    owner: value.owner,
    repo: value.repo,
    branch: value.branch,
    path: value.path,
  };
}
export const publishingTokenSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\s\p{Cc}]+$/u);
export const publishingCredentialActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preserve') }).strict(),
  z.object({ action: z.literal('remove') }).strict(),
  z
    .object({ action: z.literal('replace'), value: publishingTokenSchema })
    .strict(),
]);
export const publishingSettingsDocumentSchema = z
  .object({
    settings: publishingSettingsSchema,
    token_configured: z.boolean(),
    // A saved target and token, independent of the publishing switch.
    configured: z.boolean(),
    revision: settingsRevisionSchema,
    updated_at_iso: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
const fileUrl = z.string().trim().min(1).max(4096);
export const updatePublishingSettingsSchema = z
  .object({
    settings: publishingSettingsSchema,
    credential: publishingCredentialActionSchema,
    expected_revision: settingsRevisionSchema,
    file_url: fileUrl.optional(),
  })
  .strict();
export const testPublishingConnectionSchema = z
  .object({
    target: publishingTargetSchema.optional(),
    file_url: fileUrl.optional(),
    credential: publishingTokenSchema.optional(),
    expected_revision: settingsRevisionSchema,
  })
  .strict()
  .refine((value) => !(value.target && value.file_url));
export const publishRequestSchema = z
  .object({ expected_revision: settingsRevisionSchema })
  .strict();
const sha = z.string().regex(/^[a-f\d]{40}$/u);
export const publishingCommitSchema = z
  .object({
    sha,
    url: z
      .string()
      .url()
      .refine((value) => new URL(value).origin === 'https://github.com'),
    committed_at_iso: z.iso.datetime({ offset: true }),
  })
  .strict();
export const publishingFileStatusSchema = z
  .object({
    target: publishingTargetSchema,
    blob_sha: sha,
    commit: publishingCommitSchema,
    metadata_status: z.enum(['valid', 'missing', 'invalid', 'mismatched']),
  })
  .strict();
export const publishingStatusSchema = z
  .object({
    enabled: z.boolean(),
    configured: z.boolean(),
    revision: settingsRevisionSchema,
    file: publishingFileStatusSchema.nullable(),
  })
  .strict();
export const publishingResultSchema = z
  .object({
    outcome: z.enum(['committed', 'unchanged', 'confirmed']),
    file: publishingFileStatusSchema,
  })
  .strict();
const response = <T extends z.ZodType>(data: T) =>
  z.union([
    z.object({ success: z.literal(true), data }).strict(),
    apiErrorSchema,
  ]);
export const publishingSettingsResponseSchema = response(
  publishingSettingsDocumentSchema,
);
export const publishingConnectionResponseSchema = response(
  publishingFileStatusSchema,
);
export const publishingStatusResponseSchema = response(publishingStatusSchema);
export const publishingResultResponseSchema = response(publishingResultSchema);
export type PublishingTarget = z.infer<typeof publishingTargetSchema>;
export type PublishingSettings = z.infer<typeof publishingSettingsSchema>;
export type PublishingSettingsDocument = z.infer<
  typeof publishingSettingsDocumentSchema
>;
export type UpdatePublishingSettings = z.infer<
  typeof updatePublishingSettingsSchema
>;
export type TestPublishingConnection = z.infer<
  typeof testPublishingConnectionSchema
>;
export type PublishingFileStatus = z.infer<typeof publishingFileStatusSchema>;
export type PublishingStatus = z.infer<typeof publishingStatusSchema>;
export type PublishingResult = z.infer<typeof publishingResultSchema>;

export function parseGithubFileUrl(
  value: string,
): { owner: string; repo: string; segments: string[] } | null {
  try {
    const raw = value.trim();
    if (/[\s\\\p{Cc}]/u.test(raw)) return null;
    const url = new URL(raw);
    if (url.origin !== 'https://github.com' || url.username || url.password)
      return null;
    // Validate the unnormalized path as URL removes dot segments.
    const rawPath = raw.match(/^https:\/\/[^/?#]+([^?#]*)/iu)?.[1];
    if (!rawPath) return null;
    const parts = rawPath.split('/').slice(1).map(decodeURIComponent);
    const [rawOwner, rawRepo, kind, ...segments] = parts;
    if (
      kind !== 'blob' ||
      segments.length < 2 ||
      segments.length > 32 ||
      segments.some(
        (part) =>
          !part ||
          part.includes('/') ||
          part.includes('\\') ||
          /[\p{Cc}]/u.test(part) ||
          ['.', '..'].includes(part),
      )
    )
      return null;
    const identity = z
      .object({ owner: owner.refine(Boolean), repo: repo.refine(Boolean) })
      .safeParse({ owner: rawOwner, repo: rawRepo });
    return identity.success ? { ...identity.data, segments } : null;
  } catch {
    return null;
  }
}
export function githubFileUrl(target: PublishingTarget): string {
  if (!publishingTargetSchema.safeParse(targetFromSettings(target)).success)
    return '';
  return `https://github.com/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/blob/${[...target.branch.split('/'), ...target.path.split('/')].map(encodeURIComponent).join('/')}`;
}
export function githubTokenUrl(ownerName: string): string {
  const url = new URL('https://github.com/settings/personal-access-tokens/new');
  url.searchParams.set('name', 'ZeroPress Studio Publishing');
  url.searchParams.set('contents', 'write');
  if (owner.safeParse(ownerName).success && ownerName)
    url.searchParams.set('target_name', ownerName);
  return url.href;
}
