import { z } from 'zod';
import {
  parseGithubFileUrl,
  publishingTargetSchema,
  publishingCommitSchema,
  type PublishingTarget,
  type PublishingFileStatus,
} from '../../../contracts/publishing';
import type { ApiErrorCode } from '../../../contracts/api';
import { readPublishMetadata, type PublishMetadata } from './metadata';

export type PublishingFailureCode = Extract<
  ApiErrorCode,
  `PUBLISHING_${string}`
>;
export class PublishingFailure extends Error {
  constructor(public readonly code: PublishingFailureCode) {
    super(code);
  }
}
export class UncertainGithubWrite extends Error {
  constructor() {
    super('GitHub write result is uncertain.');
  }
}
export type GithubSnapshot = {
  file: PublishingFileStatus;
  metadata: PublishMetadata | null;
};
const sha = z.string().regex(/^[a-f\d]{40}$/u);
const refSchema = z.object({
  ref: z.string(),
  object: z.object({ type: z.literal('commit'), sha }),
});
const gitCommitSchema = z.object({ tree: z.object({ sha }) });
const historySchema = z
  .array(
    z.object({
      sha,
      commit: z.object({
        message: z.string(),
        committer: z.object({ date: z.iso.datetime({ offset: true }) }),
      }),
    }),
  )
  .max(1);
const treeSchema = z.object({
  truncated: z.boolean().optional(),
  tree: z.array(
    z.object({ path: z.string(), mode: z.string(), type: z.string(), sha }),
  ),
});
const updateSchema = z.object({
  content: z.object({ sha }),
  commit: z.object({
    sha,
    committer: z.object({ date: z.iso.datetime({ offset: true }) }),
  }),
});
function encodedPath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}
function repositoryPath(
  target: Pick<PublishingTarget, 'owner' | 'repo'>,
): string {
  return `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
}
function commitDocument(target: PublishingTarget, id: string, date: string) {
  return publishingCommitSchema.parse({
    sha: id,
    url: `https://github.com/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/commit/${id}`,
    committed_at_iso: date,
  });
}
function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success)
    throw new PublishingFailure('PUBLISHING_RESPONSE_INVALID');
  return parsed.data;
}
export function createGithubPublisher(
  token: string,
  options: {
    fetch?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
) {
  const fetchImpl = options.fetch ?? fetch;
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 25_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  let requests = 0;
  async function request(path: string, body?: object): Promise<unknown> {
    if (++requests > 80) throw new PublishingFailure('PUBLISHING_URL_INVALID');
    let response: Response;
    try {
      signal.throwIfAborted();
      response = await fetchImpl(`https://api.github.com${path}`, {
        method: body ? 'PUT' : 'GET',
        signal,
        redirect: 'manual',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'ZeroPress-Studio',
          'X-GitHub-Api-Version': '2026-03-10',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      if (body) throw new UncertainGithubWrite();
      throw new PublishingFailure('PUBLISHING_UNAVAILABLE');
    }
    if (response.status >= 500) {
      await response.body?.cancel();
      if (body) throw new UncertainGithubWrite();
      throw new PublishingFailure('PUBLISHING_UNAVAILABLE');
    }
    if (
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get('x-ratelimit-remaining') === '0' ||
          response.headers.has('retry-after')))
    ) {
      await response.body?.cancel();
      throw new PublishingFailure('PUBLISHING_RATE_LIMITED');
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (body && response.ok) throw new UncertainGithubWrite();
      throw new PublishingFailure('PUBLISHING_RESPONSE_INVALID');
    }
    if (!response.ok) {
      const message =
        payload &&
        typeof payload === 'object' &&
        'message' in payload &&
        typeof payload.message === 'string'
          ? payload.message
          : '';
      if (
        response.status === 403 &&
        /rate limit|abuse detection/iu.test(message)
      )
        throw new PublishingFailure('PUBLISHING_RATE_LIMITED');
      if (response.status === 401)
        throw new PublishingFailure('PUBLISHING_AUTHENTICATION_FAILED');
      if (
        body &&
        [403, 422].includes(response.status) &&
        /protected branch|repository rule|GH00[6]|GH013|pull request|required status check|signed commit/iu.test(
          message,
        )
      )
        throw new PublishingFailure('PUBLISHING_BRANCH_RESTRICTED');
      if (response.status === 403)
        throw new PublishingFailure('PUBLISHING_PERMISSION_DENIED');
      if (response.status === 404)
        throw new PublishingFailure('PUBLISHING_TARGET_NOT_FOUND');
      if (
        response.status === 409 ||
        (body &&
          response.status === 422 &&
          /sha|already exists|does not match/iu.test(message))
      )
        throw new PublishingFailure('PUBLISHING_CONFLICT');
      if (response.status === 422)
        throw new PublishingFailure('PUBLISHING_TARGET_INVALID');
      throw new PublishingFailure('PUBLISHING_UNAVAILABLE');
    }
    return payload;
  }
  async function readHead(target: PublishingTarget): Promise<string> {
    const value = parse(
      refSchema,
      await request(
        `${repositoryPath(target)}/git/ref/heads/${encodedPath(target.branch)}`,
      ),
    );
    if (value.ref !== `refs/heads/${target.branch}`)
      throw new PublishingFailure('PUBLISHING_TARGET_INVALID');
    return value.object.sha;
  }
  async function readFile(
    target: PublishingTarget,
    rootTree: string,
  ): Promise<string> {
    const segments = target.path.split('/');
    let treeSha = rootTree;
    for (const [index, segment] of segments.entries()) {
      const value = parse(
        treeSchema,
        await request(`${repositoryPath(target)}/git/trees/${treeSha}`),
      );
      if (value.truncated)
        throw new PublishingFailure('PUBLISHING_RESPONSE_INVALID');
      const entry = value.tree.find((item) => item.path === segment);
      if (!entry) throw new PublishingFailure('PUBLISHING_TARGET_NOT_FOUND');
      if (index === segments.length - 1) {
        if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))
          throw new PublishingFailure('PUBLISHING_TARGET_INVALID');
        return entry.sha;
      }
      if (entry.type !== 'tree' || entry.mode !== '040000')
        throw new PublishingFailure('PUBLISHING_TARGET_INVALID');
      treeSha = entry.sha;
    }
    throw new PublishingFailure('PUBLISHING_TARGET_INVALID');
  }
  async function inspect(
    targetInput: PublishingTarget,
    head?: string,
  ): Promise<GithubSnapshot> {
    const parsedTarget = publishingTargetSchema.safeParse(targetInput);
    if (!parsedTarget.success)
      throw new PublishingFailure('PUBLISHING_TARGET_INVALID');
    const target = parsedTarget.data;
    const headSha = head ?? (await readHead(target));
    const [commit, history] = await Promise.all([
      request(`${repositoryPath(target)}/git/commits/${headSha}`).then(
        (value) => parse(gitCommitSchema, value),
      ),
      request(
        `${repositoryPath(target)}/commits?${new URLSearchParams({ sha: headSha, path: target.path, per_page: '1' })}`,
      ).then((value) => parse(historySchema, value)),
    ]);
    const blobSha = await readFile(target, commit.tree.sha);
    const last = history[0];
    if (!last) throw new PublishingFailure('PUBLISHING_RESPONSE_INVALID');
    const metadata = readPublishMetadata(last.commit.message, target, blobSha);
    return {
      file: {
        target,
        blob_sha: blobSha,
        commit: commitDocument(target, last.sha, last.commit.committer.date),
        metadata_status: metadata.status,
      },
      metadata: metadata.metadata,
    };
  }
  async function resolveUrl(url: string): Promise<GithubSnapshot> {
    const parsed = parseGithubFileUrl(url);
    if (!parsed) throw new PublishingFailure('PUBLISHING_URL_INVALID');
    const matches: GithubSnapshot[] = [];
    for (let index = 1; index < parsed.segments.length; index++) {
      const candidate = publishingTargetSchema.safeParse({
        owner: parsed.owner,
        repo: parsed.repo,
        branch: parsed.segments.slice(0, index).join('/'),
        path: parsed.segments.slice(index).join('/'),
      });
      if (!candidate.success) continue;
      try {
        matches.push(await inspect(candidate.data));
      } catch (error) {
        if (
          !(error instanceof PublishingFailure) ||
          error.code !== 'PUBLISHING_TARGET_NOT_FOUND'
        )
          throw error;
      }
      if (matches.length > 1)
        throw new PublishingFailure('PUBLISHING_URL_AMBIGUOUS');
    }
    if (!matches[0]) throw new PublishingFailure('PUBLISHING_TARGET_NOT_FOUND');
    return matches[0];
  }
  async function update(
    snapshot: GithubSnapshot,
    input: { bytes: Uint8Array; blobSha: string; message: string },
  ): Promise<PublishingFileStatus> {
    const chunks: string[] = [];
    for (let index = 0; index < input.bytes.length; index += 8192)
      chunks.push(
        String.fromCharCode(...input.bytes.subarray(index, index + 8192)),
      );
    const payload = await request(
      `${repositoryPath(snapshot.file.target)}/contents/${encodedPath(snapshot.file.target.path)}`,
      {
        branch: snapshot.file.target.branch,
        sha: snapshot.file.blob_sha,
        message: input.message,
        content: btoa(chunks.join('')),
      },
    );
    const parsed = updateSchema.safeParse(payload);
    if (!parsed.success || parsed.data.content.sha !== input.blobSha)
      throw new UncertainGithubWrite();
    return {
      target: snapshot.file.target,
      blob_sha: input.blobSha,
      metadata_status: 'valid',
      commit: commitDocument(
        snapshot.file.target,
        parsed.data.commit.sha,
        parsed.data.commit.committer.date,
      ),
    };
  }
  return { inspect, resolveUrl, update };
}
