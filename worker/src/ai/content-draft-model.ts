import { z } from 'zod';
import {
  AI_CONTENT_DRAFT_CONTENT_MAX_LENGTH,
  AI_CONTENT_DRAFT_MAX_BLOCKS,
  AI_CONTENT_DRAFT_MAX_VISIBLE_CODE_POINTS,
  aiContentDraftCandidateSchema,
  type AiContentDraftTarget,
} from '../../../contracts/ai-content-draft';

export const AI_CONTENT_DRAFT_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
export const AI_CONTENT_DRAFT_GENERATION_TIMEOUT_MS = 60_000;

const proseTextSchema = z.string().min(1).max(4_000);
const listItemsSchema = z.array(z.string().min(1).max(1_000))
  .min(1)
  .max(24);

const generatedBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('heading'),
    level: z.union([z.literal(2), z.literal(3)]),
    text: proseTextSchema,
  }).strict(),
  z.object({ type: z.literal('paragraph'), text: proseTextSchema }).strict(),
  z.object({ type: z.literal('bullet_list'), items: listItemsSchema }).strict(),
  z.object({ type: z.literal('ordered_list'), items: listItemsSchema }).strict(),
  z.object({ type: z.literal('blockquote'), text: proseTextSchema }).strict(),
  z.object({ type: z.literal('code_block'), text: proseTextSchema }).strict(),
]);

const generatedContentDraftEnvelopeSchema = z.object({
  title: z.string().min(1).max(200),
  excerpt: z.string().min(1).max(500),
  blocks: z.array(generatedBlockSchema).min(1).max(AI_CONTENT_DRAFT_MAX_BLOCKS),
}).strict();

export type AiContentDraftMessage = {
  role: 'system' | 'user';
  content: string;
};

export class AiContentDraftResponseInvalidError extends Error {
  constructor() {
    super('Workers AI returned an invalid content draft response.');
    this.name = 'AiContentDraftResponseInvalidError';
  }
}

export class AiContentDraftProviderError extends Error {
  constructor(public readonly reason: 'request_failed' | 'timeout') {
    super(reason === 'timeout'
      ? 'Workers AI content draft generation timed out.'
      : 'Workers AI content draft generation failed.');
    this.name = 'AiContentDraftProviderError';
  }
}

export const aiContentDraftResponseFormat = {
  type: 'json_schema' as const,
  json_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'excerpt', 'blocks'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      excerpt: { type: 'string', minLength: 1, maxLength: 500 },
      blocks: {
        type: 'array',
        minItems: 1,
        maxItems: AI_CONTENT_DRAFT_MAX_BLOCKS,
        items: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'level', 'text'],
              properties: {
                type: { const: 'heading' },
                level: { type: 'integer', enum: [2, 3] },
                text: { type: 'string', minLength: 1, maxLength: 4_000 },
              },
            },
            ...['paragraph', 'blockquote', 'code_block'].map((type) => ({
              type: 'object',
              additionalProperties: false,
              required: ['type', 'text'],
              properties: {
                type: { const: type },
                text: { type: 'string', minLength: 1, maxLength: 4_000 },
              },
            })),
            ...['bullet_list', 'ordered_list'].map((type) => ({
              type: 'object',
              additionalProperties: false,
              required: ['type', 'items'],
              properties: {
                type: { const: type },
                items: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 24,
                  items: { type: 'string', minLength: 1, maxLength: 1_000 },
                },
              },
            })),
          ],
        },
      },
    },
  },
};

function stripJsonCodeFence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
}

function extractAiEnvelope(output: unknown): unknown {
  if (typeof output === 'string') return JSON.parse(stripJsonCodeFence(output));
  if (!output || typeof output !== 'object') return output;
  const record = output as Record<string, unknown>;
  if (record.response && typeof record.response === 'object') {
    return record.response;
  }
  if (typeof record.response === 'string') {
    return JSON.parse(stripJsonCodeFence(record.response));
  }
  if (!Array.isArray(record.choices)) return output;
  const choice = record.choices[0];
  if (!choice || typeof choice !== 'object') return output;
  const choiceRecord = choice as Record<string, unknown>;
  const message = choiceRecord.message;
  const text = typeof choiceRecord.text === 'string'
    ? choiceRecord.text
    : message && typeof message === 'object'
      && typeof (message as Record<string, unknown>).content === 'string'
      ? (message as Record<string, string>).content
      : null;
  return text === null ? output : JSON.parse(stripJsonCodeFence(text));
}

function normalizeProse(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeCode(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

type NormalizedBlock =
  | { type: 'heading'; level: 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'blockquote'; text: string }
  | { type: 'code_block'; text: string }
  | { type: 'bullet_list'; items: string[] }
  | { type: 'ordered_list'; items: string[] };

function normalizeBlocks(
  blocks: z.infer<typeof generatedBlockSchema>[],
): { blocks: NormalizedBlock[]; visibleCodePoints: number } {
  const normalized: NormalizedBlock[] = [];
  let visibleCodePoints = 0;
  for (const block of blocks) {
    if (block.type === 'bullet_list' || block.type === 'ordered_list') {
      const items = block.items.map(normalizeProse).filter(Boolean);
      if (items.length === 0) continue;
      visibleCodePoints += items.reduce((total, item) => (
        total + Array.from(item).length
      ), 0);
      normalized.push({ type: block.type, items });
      continue;
    }
    const text = block.type === 'code_block'
      ? normalizeCode(block.text)
      : normalizeProse(block.text);
    if (!text) continue;
    visibleCodePoints += Array.from(text).length;
    normalized.push(block.type === 'heading'
      ? { type: block.type, level: block.level, text }
      : { type: block.type, text });
  }
  return { blocks: normalized, visibleCodePoints };
}

function serializeHtml(blocks: NormalizedBlock[]): string {
  const html: string[] = [];
  for (const block of blocks) {
    if (block.type === 'bullet_list' || block.type === 'ordered_list') {
      const tag = block.type === 'bullet_list' ? 'ul' : 'ol';
      html.push([
        `<${tag}>`,
        ...block.items.flatMap((item) => [
          '  <li>',
          `    <p>${escapeHtml(item)}</p>`,
          '  </li>',
        ]),
        `</${tag}>`,
      ].join('\n'));
      continue;
    }
    if (block.type === 'heading') {
      html.push(`<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`);
    } else if (block.type === 'blockquote') {
      html.push([
        '<blockquote>',
        `  <p>${escapeHtml(block.text)}</p>`,
        '</blockquote>',
      ].join('\n'));
    } else if (block.type === 'code_block') {
      html.push(`<pre>${escapeHtml(block.text)}</pre>`);
    } else {
      html.push(`<p>${escapeHtml(block.text)}</p>`);
    }
  }
  return html.join('\n');
}

function escapeMarkdownText(value: string): string {
  const escaped = value
    .replace(/\\/gu, '\\\\')
    .replace(/([`*_[\]<>~])/gu, '\\$1');
  return escaped
    .replace(/^([#>])/u, '\\$1')
    .replace(/^([+-])(?=\s)/u, '\\$1')
    .replace(/^(\d+)\.(?=\s)/u, '$1\\.')
    .replace(/^(-{3,}|={3,})$/u, '\\$1');
}

function serializeMarkdown(blocks: NormalizedBlock[]): string {
  return blocks.map((block) => {
    if (block.type === 'heading') {
      return `${'#'.repeat(block.level)} ${escapeMarkdownText(block.text)}`;
    }
    if (block.type === 'bullet_list') {
      return block.items
        .map((item) => `- ${escapeMarkdownText(item)}`)
        .join('\n');
    }
    if (block.type === 'ordered_list') {
      return block.items
        .map((item, index) => `${index + 1}. ${escapeMarkdownText(item)}`)
        .join('\n');
    }
    if (block.type === 'blockquote') {
      return `> ${escapeMarkdownText(block.text)}`;
    }
    if (block.type === 'code_block') {
      const longestRun = Math.max(
        0,
        ...Array.from(block.text.matchAll(/`+/gu), (match) => match[0].length),
      );
      const fence = '`'.repeat(Math.max(3, longestRun + 1));
      return `${fence}\n${block.text}\n${fence}`;
    }
    return escapeMarkdownText(block.text);
  }).join('\n\n');
}

function serializePlaintext(blocks: NormalizedBlock[]): string {
  return blocks.map((block) => {
    if (block.type === 'bullet_list') {
      return block.items.map((item) => `• ${item}`).join('\n');
    }
    if (block.type === 'ordered_list') {
      return block.items
        .map((item, index) => `${index + 1}. ${item}`)
        .join('\n');
    }
    if (block.type === 'blockquote') return `> ${block.text}`;
    if (block.type === 'code_block') {
      return block.text
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n');
    }
    return block.text;
  }).join('\n\n');
}

function parseAiOutput(output: unknown, target: AiContentDraftTarget) {
  let envelope: z.infer<typeof generatedContentDraftEnvelopeSchema>;
  try {
    const parsed = generatedContentDraftEnvelopeSchema.safeParse(
      extractAiEnvelope(output),
    );
    if (!parsed.success) throw new AiContentDraftResponseInvalidError();
    envelope = parsed.data;
  } catch (error) {
    if (error instanceof AiContentDraftResponseInvalidError) throw error;
    throw new AiContentDraftResponseInvalidError();
  }

  const title = normalizeProse(envelope.title);
  const excerpt = normalizeProse(envelope.excerpt);
  const normalized = normalizeBlocks(envelope.blocks);
  const content = target.document_type === 'html'
    ? serializeHtml(normalized.blocks)
    : target.document_type === 'markdown'
      ? serializeMarkdown(normalized.blocks)
      : serializePlaintext(normalized.blocks);
  if (
    normalized.visibleCodePoints === 0
    || normalized.visibleCodePoints > AI_CONTENT_DRAFT_MAX_VISIBLE_CODE_POINTS
    || content.length > AI_CONTENT_DRAFT_CONTENT_MAX_LENGTH
  ) throw new AiContentDraftResponseInvalidError();
  const candidate = aiContentDraftCandidateSchema.safeParse({
    title,
    excerpt,
    content,
    document_type: target.document_type,
    editor_mode: target.editor_mode,
    editor_profile: target.document_type === 'html'
      && target.editor_mode === 'visual'
      ? 'tiptap-v1'
      : null,
  });
  if (!candidate.success) throw new AiContentDraftResponseInvalidError();
  return candidate.data;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new AiContentDraftProviderError('timeout')),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export async function generateAiContentDraft(input: {
  ai: Ai;
  messages: AiContentDraftMessage[];
  target: AiContentDraftTarget;
  timeoutMs?: number;
}) {
  let output: unknown;
  try {
    output = await withTimeout(
      input.ai.run(AI_CONTENT_DRAFT_MODEL, {
        messages: input.messages,
        max_tokens: 4_096,
        temperature: 0.5,
        top_p: 0.9,
        repetition_penalty: 1.1,
        response_format: aiContentDraftResponseFormat,
      }),
      input.timeoutMs ?? AI_CONTENT_DRAFT_GENERATION_TIMEOUT_MS,
    );
  } catch (error) {
    if (
      error instanceof AiContentDraftProviderError
      || error instanceof AiContentDraftResponseInvalidError
    ) throw error;
    throw new AiContentDraftProviderError('request_failed');
  }
  return parseAiOutput(output, input.target);
}
