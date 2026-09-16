import { StudioOperationalError } from '../lib/operational-error';
import { readCommentSettingsState } from '../settings/comment-settings-repository';
import {
  createCommentRequestTokenSigner,
  parseCommentRequestSecrets,
  type CommentTargetType,
} from './request-secrets';

type TargetNonceRow = {
  target_type?: unknown;
  public_id?: unknown;
  request_token_nonce?: unknown;
};

export type CommentTokenTarget = {
  targetType: CommentTargetType;
  publicId: number;
};

const TARGET_LOOKUP_CHUNK_SIZE = 90;

export function commentTargetKey(
  targetType: CommentTargetType,
  publicId: number,
): string {
  return `${targetType}:${publicId}`;
}

function assertTarget(target: CommentTokenTarget): void {
  if (
    !['post', 'page'].includes(target.targetType)
    || !Number.isInteger(target.publicId)
    || target.publicId <= 0
  ) {
    throw new TypeError('Comment token target must have a valid type and ID.');
  }
}

function targetNotProjected(target: CommentTokenTarget): StudioOperationalError {
  return new StudioOperationalError('COMMENT_TARGET_NOT_PROJECTED', {
    metadata: {
      resource: 'EDGE_DB',
      action: 'create_comment_request_token',
      targetType: target.targetType,
      targetPublicId: target.publicId,
    },
  });
}

export async function createCommentRequestTokens(input: {
  edgeDb: D1Database;
  targets: CommentTokenTarget[];
}): Promise<Map<string, string>> {
  for (const target of input.targets) assertTarget(target);
  if (input.targets.length === 0) return new Map();

  const uniqueTargets = new Map(
    input.targets.map((target) => [
      commentTargetKey(target.targetType, target.publicId),
      target,
    ]),
  );
  const nonceByTarget = new Map<string, string>();

  try {
    for (const targetType of ['post', 'page'] as const) {
      const publicIds = [...uniqueTargets.values()]
        .filter((target) => target.targetType === targetType)
        .map((target) => target.publicId);
      for (
        let index = 0;
        index < publicIds.length;
        index += TARGET_LOOKUP_CHUNK_SIZE
      ) {
        const chunk = publicIds.slice(index, index + TARGET_LOOKUP_CHUNK_SIZE);
        if (chunk.length === 0) continue;
        const placeholders = chunk.map(() => '?').join(', ');
        const result = await input.edgeDb.prepare(`
          SELECT target_type, public_id, request_token_nonce
          FROM edge_comment_targets
          WHERE target_type = ? AND public_id IN (${placeholders})
        `).bind(targetType, ...chunk).all<TargetNonceRow>();
        for (const row of result.results ?? []) {
          const publicId = Number(row.public_id);
          const nonce = typeof row.request_token_nonce === 'string'
            ? row.request_token_nonce.trim()
            : '';
          if (
            row.target_type === targetType
            && Number.isInteger(publicId)
            && publicId > 0
            && nonce
          ) {
            nonceByTarget.set(
              commentTargetKey(targetType, publicId),
              nonce,
            );
          }
        }
      }
    }
  } catch (error) {
    throw new StudioOperationalError(
      'COMMENT_REQUEST_TOKEN_DATABASE_QUERY_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'EDGE_DB',
          action: 'read_comment_target_nonces',
          targetCount: uniqueTargets.size,
        },
      },
    );
  }

  for (const [key, target] of uniqueTargets) {
    if (!nonceByTarget.has(key)) throw targetNotProjected(target);
  }

  const settings = await readCommentSettingsState({ edgeDb: input.edgeDb });
  if (settings.requestSecretsJson === null) {
    throw new StudioOperationalError('COMMENT_REQUEST_SECRETS_NOT_CONFIGURED', {
      metadata: {
        resource: 'EDGE_DB',
        action: 'create_comment_request_tokens',
      },
    });
  }
  let secrets;
  try {
    secrets = parseCommentRequestSecrets(settings.requestSecretsJson);
  } catch (error) {
    throw new StudioOperationalError('COMMENT_SETTINGS_DATA_INVALID', {
      cause: error,
      metadata: {
        resource: 'EDGE_DB',
        action: 'validate_comment_request_secrets',
      },
    });
  }

  const tokens = new Map<string, string>();
  try {
    const sign = await createCommentRequestTokenSigner(
      secrets.current.secret,
    );
    for (const [key, target] of uniqueTargets) {
      const signature = await sign({
        targetType: target.targetType,
        publicId: target.publicId,
        nonce: nonceByTarget.get(key)!,
      });
      tokens.set(key, `${secrets.current.kid}.${signature}`);
    }
  } catch (error) {
    throw new StudioOperationalError('COMMENT_REQUEST_TOKEN_CRYPTO_FAILED', {
      cause: error,
      metadata: {
        component: 'web_crypto',
        action: 'sign_comment_request_tokens',
        targetCount: uniqueTargets.size,
      },
    });
  }
  return tokens;
}
