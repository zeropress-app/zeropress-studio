import sax from 'sax';
import {
  generateContentSlug,
  normalizeStoredSlug,
  validateSlugSegment,
} from '@zeropress/slug-policy';
import {
  AUTHOR_DISPLAY_NAME_MAX_LENGTH,
  suggestAuthorId,
} from '../../../contracts/authors';
import { ZEROPRESS_NATIVE_PUBLIC_ID_BASE } from '../../../contracts/content-public-id';
import {
  COMMENT_AUTHOR_EMAIL_MAX_LENGTH,
  COMMENT_AUTHOR_NAME_MAX_LENGTH,
  COMMENT_CONTENT_MAX_LENGTH,
  commentAuthorEmailSchema,
} from '../../../contracts/comments';
import {
  createManagedMediaReference,
  MANAGED_MEDIA_REFERENCE_PREFIX,
  MEDIA_ALT_MAX_CODE_POINTS,
  MEDIA_DIMENSION_MAX,
  mediaLocationIdentity,
  normalizeExternalMediaUrl,
  normalizeMediaFilename,
  normalizeMediaMimeType,
  normalizeMediaStorageKey,
  type MediaLocation,
} from '../../../contracts/media';
import {
  MENU_ITEMS_JSON_MAX_BYTES,
  MENU_ITEM_TITLE_MAX_LENGTH,
  MENU_MAX_COUNT,
  MENU_MAX_DEPTH,
  MENU_MAX_ITEMS,
  MENU_NAME_MAX_LENGTH,
  menuCustomUrlSchema,
} from '../../../contracts/menus';
import {
  POST_CONTENT_MAX_LENGTH,
  POST_EXCERPT_MAX_LENGTH,
  POST_RELATION_MAX_ITEMS,
  POST_TITLE_MAX_LENGTH,
} from '../../../contracts/posts';
import {
  PAGE_CONTENT_MAX_LENGTH,
  PAGE_EXCERPT_MAX_LENGTH,
  PAGE_TITLE_MAX_LENGTH,
} from '../../../contracts/pages';
import {
  normalizeSiteDescription,
  normalizeSiteLocale,
  normalizeSiteOrigin,
  normalizeSiteTitle,
} from '../../../contracts/general-settings';
import type { RoutingSettings } from '../../../contracts/routing-settings';
import type {
  WxrImportAuthorRow,
  WxrImportCategoryRow,
  WxrImportCommentRow,
  WxrImportMenuItem,
  WxrImportMenuRow,
  WxrImportMediaRow,
  WxrImportPageRow,
  WxrImportPostRow,
  WxrImportTagRow,
} from '../../../contracts/wxr-import';
import {
  wxrImportAuthorRowSchema,
  wxrImportCategoryRowSchema,
  wxrImportCommentRowSchema,
  wxrImportMenuRowSchema,
  wxrImportMediaRowSchema,
  wxrImportPageRowSchema,
  wxrImportPostRowSchema,
  wxrImportTagRowSchema,
} from '../../../contracts/wxr-import';
import { computeImportedHtmlExcerpt } from '../../../contracts/document-excerpt';
import {
  classifyTiptapHtml,
  type TiptapFallbackReason,
} from '../editor/tiptap-compatibility';
import { materializeWordPressClassicHtml } from './wordpress-content';

const WXR_NAMESPACE = 'http://wordpress.org/export/1.2/';
const CONTENT_NAMESPACE = 'http://purl.org/rss/1.0/modules/content/';
const DC_NAMESPACE = 'http://purl.org/dc/elements/1.1/';
const EXCERPT_NAMESPACE = 'http://wordpress.org/export/1.2/excerpt/';
const MAX_METADATA_TEXT = 2 * 1024 * 1024;
const WXR_COMMENT_SOURCE_MAX_LENGTH = 20_000;
const MAX_WARNING_AFFECTED = 50;
const MAX_WARNING_LABEL_LENGTH = 200;
const MAX_UNIQUE_SUFFIX_ATTEMPTS = 1_000;

const CHANNEL_TEXT_FIELDS = new Set([
  'title',
  'description',
  'link',
  'language',
]);
const CHANNEL_WP_FIELDS = new Set([
  'base_blog_url',
  'base_site_url',
  'wxr_version',
]);
const AUTHOR_WP_FIELDS = new Set([
  'author_id',
  'author_login',
  'author_display_name',
]);
const CATEGORY_WP_FIELDS = new Set([
  'term_id',
  'category_nicename',
  'cat_name',
  'category_description',
]);
const TAG_WP_FIELDS = new Set([
  'term_id',
  'tag_slug',
  'tag_name',
  'tag_description',
]);
const TERM_WP_FIELDS = new Set([
  'term_id',
  'term_slug',
  'term_name',
  'term_taxonomy',
]);
const ITEM_WP_FIELDS = new Set([
  'attachment_url',
  'comment_status',
  'post_date',
  'post_date_gmt',
  'post_id',
  'post_modified_gmt',
  'post_mime_type',
  'menu_order',
  'post_name',
  'post_parent',
  'post_password',
  'post_type',
  'status',
]);
const COMMENT_WP_FIELDS = new Set([
  'comment_approved',
  'comment_author',
  'comment_author_email',
  'comment_content',
  'comment_date_gmt',
  'comment_id',
  'comment_parent',
  'comment_type',
]);
const IMPORTED_POST_META_KEYS = new Set([
  '_thumbnail_id',
  '_wp_attached_file',
  '_wp_attachment_image_alt',
  '_wp_attachment_metadata',
  '_menu_item_menu_item_parent',
  '_menu_item_object',
  '_menu_item_object_id',
  '_menu_item_target',
  '_menu_item_type',
  '_menu_item_url',
  '_yoast_wpseo_metadesc',
  'rank_math_description',
  '_aioseo_description',
  '_genesis_description',
]);
const SEO_DESCRIPTION_META_KEYS = [
  '_yoast_wpseo_metadesc',
  'rank_math_description',
  '_aioseo_description',
  '_genesis_description',
] as const;

type RawRecord = { wp: Record<string, string> };
type RawCategory = { domain: string; nicename: string; text: string };
type RawComment = RawRecord & { oversized: Set<string> };
type RawItem = RawRecord & {
  title: string;
  link: string;
  creator: string;
  content: string;
  excerpt: string;
  postmeta: Record<string, string>;
  categories: RawCategory[];
  comments: RawComment[];
  oversized: Set<string>;
};
type RawDocument = {
  channel: RawRecord & {
    title: string;
    description: string;
    link: string;
    language: string;
  };
  channelTextFields: Set<string>;
  channelCount: number;
  hasWxrNamespace: boolean;
  authors: RawRecord[];
  categories: RawRecord[];
  tags: RawRecord[];
  terms: RawRecord[];
  items: RawItem[];
  unsupportedItemTypes: Map<string, number>;
};
type SaxNode = {
  name: string;
  local?: string;
  uri?: string;
  ns?: Record<string, string>;
  attributes?: Record<string, {
    name?: string;
    local?: string;
    uri?: string;
    value?: unknown;
  }>;
};
type Frame = {
  local: string;
  uri: string;
  attributes: SaxNode['attributes'];
  role: string;
  record: RawDocument['channel'] | RawRecord | RawComment | RawItem | {
    key: string;
    value: string;
  } | null;
  collectText: boolean;
  text: string[];
  textLength: number;
  textLimit: number;
  overflow: boolean;
};

export type WxrCoreWarningCode =
  | 'compacted_comment_whitespace'
  | 'content_limits_skipped'
  | 'invalid_comment_statuses'
  | 'invalid_comment_emails_discarded'
  | 'invalid_comment_parents'
  | 'invalid_dates_skipped'
  | 'invalid_public_ids_skipped'
  | 'media_metadata_skipped'
  | 'orphan_menu_parents'
  | 'orphan_page_parents'
  | 'password_protected_downgraded'
  | 'resolved_slug_conflicts'
  | 'discarded_cyclic_menu_items'
  | 'discarded_deep_menu_items'
  | 'skipped_menu_items'
  | 'synthesized_authors'
  | 'synthesized_taxonomies'
  | 'locale_inference_skipped'
  | 'timezone_inference_ambiguous'
  | 'timezone_inference_skipped'
  | 'truncated_fields'
  | 'unsupported_items_skipped'
  | 'unsupported_comment_statuses_skipped'
  | 'unsupported_comment_types_skipped'
  | 'unsupported_statuses_downgraded'
  | 'unresolved_featured_images';

export type WxrCoreWarning = {
  code: WxrCoreWarningCode;
  count: number;
  affected: string[];
};

export type WxrCoreImportPlan = {
  source: {
    site_title: string;
    site_url: string;
    site_settings: {
      title: string | null;
      description: string | null;
      url: {
        source: string;
        origin: string;
      } | null;
      locale: string | null;
      timezone: string | null;
    };
    permalinks: {
      output_style: RoutingSettings['permalinks']['output_style'] | null;
      posts: string | null;
      pages: string | null;
    };
    media_strategy: WxrMediaStrategy;
    media_from: string | null;
  };
  rows: {
    authors: WxrImportAuthorRow[];
    categories: WxrImportCategoryRow[];
    tags: WxrImportTagRow[];
    media: WxrImportMediaRow[];
    posts: WxrImportPostRow[];
    pages: WxrImportPageRow[];
    menus: WxrImportMenuRow[];
    comments: WxrImportCommentRow[];
  };
  editor_compatibility: {
    visual: number;
    source: number;
    source_fallbacks: Array<{
      reason: TiptapFallbackReason;
      count: number;
      affected: string[];
    }>;
  };
  warnings: WxrCoreWarning[];
};

export type WxrCoreParseErrorCode =
  | 'INVALID_XML'
  | 'INVALID_WXR'
  | 'UNSUPPORTED_VERSION'
  | 'DUPLICATE_PUBLIC_ID'
  | 'PAGE_CYCLE'
  | 'NO_IMPORTABLE_CONTENT'
  | 'MEDIA_PREFIX_INVALID'
  | 'MEDIA_PREFIX_REQUIRED'
  | 'FILE_READ_FAILED';

export type WxrMediaStrategy = 'external' | 'r2';

export type WxrCoreParserOptions = {
  mediaStrategy?: WxrMediaStrategy;
  mediaFrom?: string;
};

export class WxrCoreParseError extends Error {
  constructor(readonly code: WxrCoreParseErrorCode) {
    super(code);
    this.name = 'WxrCoreParseError';
  }
}

function normalizeWarningLabel(value: string): string {
  return value.trim().slice(0, MAX_WARNING_LABEL_LENGTH).trim() || 'unknown';
}

class WarningAccumulator {
  readonly values = new Map<WxrCoreWarningCode, WxrCoreWarning>();

  add(code: WxrCoreWarningCode, affected: string) {
    this.addCount(code, affected, 1);
  }

  addCount(code: WxrCoreWarningCode, affected: string, count: number) {
    const warning = this.values.get(code) ?? { code, count: 0, affected: [] };
    warning.count += count;
    const label = normalizeWarningLabel(affected);
    if (
      warning.affected.length < MAX_WARNING_AFFECTED
      && !warning.affected.includes(label)
    ) warning.affected.push(label);
    this.values.set(code, warning);
  }

  list(): WxrCoreWarning[] {
    return [...this.values.values()].sort((left, right) => (
      left.code < right.code ? -1 : left.code > right.code ? 1 : 0
    ));
  }
}

function createDocument(): RawDocument {
  return {
    channel: {
      title: '',
      description: '',
      link: '',
      language: '',
      wp: {},
    },
    channelTextFields: new Set(),
    channelCount: 0,
    hasWxrNamespace: false,
    authors: [],
    categories: [],
    tags: [],
    terms: [],
    items: [],
    unsupportedItemTypes: new Map(),
  };
}

function createItem(): RawItem {
  return {
    title: '',
    link: '',
    creator: '',
    content: '',
    excerpt: '',
    wp: {},
    postmeta: {},
    categories: [],
    comments: [],
    oversized: new Set(),
  };
}

function attributeValue(node: SaxNode | Frame, localName: string): string {
  for (const attribute of Object.values(node.attributes ?? {})) {
    if (
      (attribute.uri ?? '') === ''
      && (attribute.local ?? attribute.name) === localName
    ) return String(attribute.value ?? '');
  }
  return '';
}

function isElement(node: SaxNode, uri: string, local: string): boolean {
  return (node.uri ?? '') === uri && (node.local ?? node.name) === local;
}

function frameTextLimit(frame: Frame, parent: Frame | null): number {
  if (parent?.role === 'item' && frame.uri === CONTENT_NAMESPACE) {
    return POST_CONTENT_MAX_LENGTH + 1;
  }
  if (parent?.role === 'item' && frame.uri === EXCERPT_NAMESPACE) {
    return 100_000;
  }
  if (
    parent?.role === 'postmeta'
    && frame.local === 'meta_value'
  ) return MAX_METADATA_TEXT;
  if (parent?.role === 'comment') {
    if (frame.local === 'comment_content') {
      return WXR_COMMENT_SOURCE_MAX_LENGTH + 1;
    }
    if (frame.local === 'comment_author') {
      return COMMENT_AUTHOR_NAME_MAX_LENGTH + 1;
    }
    if (frame.local === 'comment_author_email') {
      return COMMENT_AUTHOR_EMAIL_MAX_LENGTH + 1;
    }
  }
  return 20_000;
}

function createFrame(node: SaxNode, parent: Frame | null): Frame {
  const frame: Frame = {
    local: node.local ?? node.name,
    uri: node.uri ?? '',
    attributes: node.attributes,
    role: '',
    record: null,
    collectText: false,
    text: [],
    textLength: 0,
    textLimit: Number.MAX_SAFE_INTEGER,
    overflow: false,
  };
  frame.textLimit = frameTextLimit(frame, parent);
  return frame;
}

function shouldCollectText(frame: Frame, parent: Frame | null): boolean {
  if (!parent) return false;
  if (parent.role === 'channel') {
    return (frame.uri === '' && CHANNEL_TEXT_FIELDS.has(frame.local))
      || (frame.uri === WXR_NAMESPACE && CHANNEL_WP_FIELDS.has(frame.local));
  }
  if (parent.role === 'author') {
    return frame.uri === WXR_NAMESPACE && AUTHOR_WP_FIELDS.has(frame.local);
  }
  if (parent.role === 'category-record') {
    return frame.uri === WXR_NAMESPACE && CATEGORY_WP_FIELDS.has(frame.local);
  }
  if (parent.role === 'tag-record') {
    return frame.uri === WXR_NAMESPACE && TAG_WP_FIELDS.has(frame.local);
  }
  if (parent.role === 'term-record') {
    return frame.uri === WXR_NAMESPACE && TERM_WP_FIELDS.has(frame.local);
  }
  if (parent.role === 'postmeta' && frame.uri === WXR_NAMESPACE) {
    if (frame.local === 'meta_key') return true;
    return frame.local === 'meta_value'
      && IMPORTED_POST_META_KEYS.has(
        (parent.record as { key: string }).key,
      );
  }
  if (parent.role === 'comment') {
    return frame.uri === WXR_NAMESPACE && COMMENT_WP_FIELDS.has(frame.local);
  }
  if (parent.role !== 'item') return false;
  return (frame.uri === '' && (
    frame.local === 'title'
    || frame.local === 'link'
    || frame.local === 'category'
  ))
    || (frame.uri === DC_NAMESPACE && frame.local === 'creator')
    || (frame.uri === CONTENT_NAMESPACE && frame.local === 'encoded')
    || (frame.uri === EXCERPT_NAMESPACE && frame.local === 'encoded')
    || (frame.uri === WXR_NAMESPACE && ITEM_WP_FIELDS.has(frame.local));
}

function appendText(stack: Frame[], value: string) {
  const frame = stack.at(-1);
  if (!frame?.collectText || frame.overflow) return;
  const remaining = frame.textLimit - frame.textLength;
  if (remaining <= 0) {
    frame.overflow = true;
    return;
  }
  if (value.length > remaining) {
    frame.text.push(value.slice(0, remaining));
    frame.textLength += remaining;
    frame.overflow = true;
    return;
  }
  frame.text.push(value);
  frame.textLength += value.length;
}

function captureClosedFrame(
  document: RawDocument,
  frame: Frame,
  parent: Frame | null,
) {
  if (!parent) return;
  const value = frame.text.join('').replace(/\r\n?/gu, '\n').trim();
  if (parent.role === 'channel') {
    const channel = parent.record as RawDocument['channel'];
    if (frame.uri === '' && CHANNEL_TEXT_FIELDS.has(frame.local)) {
      channel[
        frame.local as 'title' | 'description' | 'link' | 'language'
      ] = value;
      document.channelTextFields.add(frame.local);
    } else if (frame.uri === WXR_NAMESPACE && CHANNEL_WP_FIELDS.has(frame.local)) {
      channel.wp[frame.local] = value;
    }
    if (frame.role === 'author') document.authors.push(frame.record as RawRecord);
    if (frame.role === 'category-record') {
      document.categories.push(frame.record as RawRecord);
    }
    if (frame.role === 'tag-record') document.tags.push(frame.record as RawRecord);
    if (frame.role === 'term-record') document.terms.push(frame.record as RawRecord);
    if (frame.role === 'item') {
      const item = frame.record as RawItem;
      const type = item.wp.post_type?.trim() ?? '';
      if (
        type === 'post'
        || type === 'page'
        || type === 'attachment'
        || type === 'nav_menu_item'
      ) {
        document.items.push(item);
      } else {
        const label = normalizeWarningLabel(type || 'unknown');
        const storedLabel = document.unsupportedItemTypes.has(label)
          || document.unsupportedItemTypes.size < MAX_WARNING_AFFECTED
          ? label
          : document.unsupportedItemTypes.keys().next().value ?? 'unknown';
        document.unsupportedItemTypes.set(
          storedLabel,
          (document.unsupportedItemTypes.get(storedLabel) ?? 0) + 1,
        );
      }
    }
    return;
  }
  if (
    ['author', 'category-record', 'tag-record', 'term-record'].includes(parent.role)
    && frame.uri === WXR_NAMESPACE
  ) {
    (parent.record as RawRecord).wp[frame.local] = value;
    return;
  }
  if (parent.role === 'postmeta' && frame.uri === WXR_NAMESPACE) {
    const record = parent.record as { key: string; value: string };
    if (frame.local === 'meta_key') record.key = value;
    if (frame.local === 'meta_value') record.value = value;
    return;
  }
  if (frame.role === 'postmeta' && parent.role === 'item') {
    const item = parent.record as RawItem;
    const meta = frame.record as { key: string; value: string };
    if (frame.overflow) item.oversized.add(`postmeta:${meta.key}`);
    if (
      IMPORTED_POST_META_KEYS.has(meta.key)
      && item.postmeta[meta.key] === undefined
    ) item.postmeta[meta.key] = meta.value;
    return;
  }
  if (frame.role === 'comment' && parent.role === 'item') {
    (parent.record as RawItem).comments.push(frame.record as RawComment);
    return;
  }
  if (parent.role === 'comment' && frame.uri === WXR_NAMESPACE) {
    const comment = parent.record as RawComment;
    if (frame.overflow) comment.oversized.add(frame.local);
    comment.wp[frame.local] = value;
    return;
  }
  if (parent.role !== 'item') return;
  const item = parent.record as RawItem;
  if (frame.overflow) item.oversized.add(frame.uri === CONTENT_NAMESPACE
    ? 'content'
    : frame.uri === EXCERPT_NAMESPACE
      ? 'excerpt'
      : frame.local);
  if (frame.uri === '' && frame.local === 'title') item.title = value;
  if (frame.uri === '' && frame.local === 'link') item.link = value;
  if (frame.uri === DC_NAMESPACE && frame.local === 'creator') {
    item.creator = value;
  }
  if (frame.uri === CONTENT_NAMESPACE && frame.local === 'encoded') {
    item.content = value;
  }
  if (frame.uri === EXCERPT_NAMESPACE && frame.local === 'encoded') {
    item.excerpt = value;
  }
  if (frame.uri === WXR_NAMESPACE && ITEM_WP_FIELDS.has(frame.local)) {
    item.wp[frame.local] = value;
  }
  if (frame.uri === '' && frame.local === 'category') {
    item.categories.push({
      domain: attributeValue(frame, 'domain'),
      nicename: attributeValue(frame, 'nicename'),
      text: value,
    });
  }
}

function writeParserChunk(parser: ReturnType<typeof sax.parser>, chunk: string) {
  const normalized = chunk
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .replace(/[\u2028\u2029]/gu, '\n');
  if (normalized) parser.write(normalized);
}

type Utf8Sequence = Readonly<{
  length: number;
  secondMinimum: number;
  secondMaximum: number;
}>;

const UTF8_2_BYTE_SEQUENCE: Utf8Sequence = {
  length: 2,
  secondMinimum: 0x80,
  secondMaximum: 0xbf,
};
const UTF8_3_BYTE_LOW_SEQUENCE: Utf8Sequence = {
  length: 3,
  secondMinimum: 0xa0,
  secondMaximum: 0xbf,
};
const UTF8_3_BYTE_SEQUENCE: Utf8Sequence = {
  length: 3,
  secondMinimum: 0x80,
  secondMaximum: 0xbf,
};
const UTF8_3_BYTE_NON_SURROGATE_SEQUENCE: Utf8Sequence = {
  length: 3,
  secondMinimum: 0x80,
  secondMaximum: 0x9f,
};
const UTF8_4_BYTE_LOW_SEQUENCE: Utf8Sequence = {
  length: 4,
  secondMinimum: 0x90,
  secondMaximum: 0xbf,
};
const UTF8_4_BYTE_SEQUENCE: Utf8Sequence = {
  length: 4,
  secondMinimum: 0x80,
  secondMaximum: 0xbf,
};
const UTF8_4_BYTE_HIGH_SEQUENCE: Utf8Sequence = {
  length: 4,
  secondMinimum: 0x80,
  secondMaximum: 0x8f,
};

/**
 * Preserve valid UTF-8 sequences while dropping malformed bytes. This matches
 * the WXR CLI policy and avoids TextDecoder materializing replacement chars.
 */
function createUtf8Sanitizer() {
  let pending = new Uint8Array(0);

  return {
    write(chunk: Uint8Array): Uint8Array {
      const source = pending.length > 0 ? concatenateBytes(pending, chunk) : chunk;
      pending = new Uint8Array(0);

      const output = new Uint8Array(source.length);
      let inputOffset = 0;
      let outputOffset = 0;

      while (inputOffset < source.length) {
        const lead = source[inputOffset]!;
        if (lead <= 0x7f) {
          output[outputOffset] = lead;
          inputOffset += 1;
          outputOffset += 1;
          continue;
        }

        const sequence = utf8Sequence(lead);
        if (!sequence) {
          inputOffset += 1;
          continue;
        }

        const available = source.length - inputOffset;
        const inspectedLength = Math.min(available, sequence.length);
        if (!hasValidContinuationPrefix(source, inputOffset, inspectedLength, sequence)) {
          inputOffset += 1;
          continue;
        }
        if (available < sequence.length) {
          pending = source.slice(inputOffset);
          break;
        }

        output.set(source.subarray(inputOffset, inputOffset + sequence.length), outputOffset);
        inputOffset += sequence.length;
        outputOffset += sequence.length;
      }

      return output.subarray(0, outputOffset);
    },

    end(): void {
      pending = new Uint8Array(0);
    },
  };
}

function concatenateBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const combined = new Uint8Array(first.length + second.length);
  combined.set(first);
  combined.set(second, first.length);
  return combined;
}

function utf8Sequence(lead: number): Utf8Sequence | null {
  if (lead >= 0xc2 && lead <= 0xdf) return UTF8_2_BYTE_SEQUENCE;
  if (lead === 0xe0) return UTF8_3_BYTE_LOW_SEQUENCE;
  if ((lead >= 0xe1 && lead <= 0xec) || (lead >= 0xee && lead <= 0xef)) {
    return UTF8_3_BYTE_SEQUENCE;
  }
  if (lead === 0xed) return UTF8_3_BYTE_NON_SURROGATE_SEQUENCE;
  if (lead === 0xf0) return UTF8_4_BYTE_LOW_SEQUENCE;
  if (lead >= 0xf1 && lead <= 0xf3) return UTF8_4_BYTE_SEQUENCE;
  if (lead === 0xf4) return UTF8_4_BYTE_HIGH_SEQUENCE;
  return null;
}

function hasValidContinuationPrefix(
  source: Uint8Array,
  offset: number,
  inspectedLength: number,
  sequence: Utf8Sequence,
): boolean {
  if (inspectedLength >= 2) {
    const second = source[offset + 1]!;
    if (second < sequence.secondMinimum || second > sequence.secondMaximum) return false;
  }

  for (let index = 2; index < inspectedLength; index += 1) {
    const continuation = source[offset + index]!;
    if (continuation < 0x80 || continuation > 0xbf) return false;
  }
  return true;
}

async function parseWxrFile(file: File): Promise<RawDocument> {
  const document = createDocument();
  const stack: Frame[] = [];
  const parser = sax.parser(true, {
    xmlns: true,
    strictEntities: true,
    trim: false,
    normalize: false,
  });
  parser.onerror = () => {
    throw new WxrCoreParseError('INVALID_XML');
  };
  parser.ondoctype = () => {
    throw new WxrCoreParseError('INVALID_WXR');
  };
  parser.onopentag = (node) => {
    const parent = stack.at(-1) ?? null;
    const frame = createFrame(node, parent);
    if (!parent) {
      if (!isElement(node, '', 'rss') || attributeValue(node, 'version') !== '2.0') {
        throw new WxrCoreParseError('INVALID_WXR');
      }
      frame.role = 'root';
      document.hasWxrNamespace = Object.values(node.ns ?? {})
        .includes(WXR_NAMESPACE);
    } else if (parent.role === 'root' && isElement(node, '', 'channel')) {
      document.channelCount += 1;
      if (document.channelCount > 1) {
        throw new WxrCoreParseError('INVALID_WXR');
      }
      frame.role = 'channel';
      frame.record = document.channel;
    } else if (parent.role === 'channel') {
      if (isElement(node, WXR_NAMESPACE, 'author')) {
        frame.role = 'author';
        frame.record = { wp: {} };
      } else if (isElement(node, WXR_NAMESPACE, 'category')) {
        frame.role = 'category-record';
        frame.record = { wp: {} };
      } else if (isElement(node, WXR_NAMESPACE, 'tag')) {
        frame.role = 'tag-record';
        frame.record = { wp: {} };
      } else if (isElement(node, WXR_NAMESPACE, 'term')) {
        frame.role = 'term-record';
        frame.record = { wp: {} };
      } else if (isElement(node, '', 'item')) {
        frame.role = 'item';
        frame.record = createItem();
      }
    } else if (
      parent.role === 'item'
      && isElement(node, WXR_NAMESPACE, 'postmeta')
    ) {
      frame.role = 'postmeta';
      frame.record = { key: '', value: '' };
    } else if (
      parent.role === 'item'
      && isElement(node, WXR_NAMESPACE, 'comment')
    ) {
      frame.role = 'comment';
      frame.record = { wp: {}, oversized: new Set() };
    }
    frame.collectText = shouldCollectText(frame, parent);
    stack.push(frame);
  };
  parser.ontext = (text) => appendText(stack, text);
  parser.oncdata = (text) => appendText(stack, text);
  parser.onclosetag = () => {
    const frame = stack.pop();
    if (!frame) throw new WxrCoreParseError('INVALID_XML');
    captureClosedFrame(document, frame, stack.at(-1) ?? null);
  };

  const reader = file.stream().getReader();
  const decoder = new TextDecoder('utf-8');
  const utf8Sanitizer = createUtf8Sanitizer();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const sanitized = utf8Sanitizer.write(result.value);
      writeParserChunk(parser, decoder.decode(sanitized, { stream: true }));
    }
    utf8Sanitizer.end();
    writeParserChunk(parser, decoder.decode());
    parser.close();
  } catch (error) {
    if (error instanceof WxrCoreParseError) throw error;
    throw new WxrCoreParseError('FILE_READ_FAILED');
  } finally {
    reader.releaseLock();
  }

  if (document.channelCount !== 1 || !document.hasWxrNamespace) {
    throw new WxrCoreParseError('INVALID_WXR');
  }
  if ((document.channel.wp.wxr_version ?? '').trim() !== '1.2') {
    throw new WxrCoreParseError('UNSUPPORTED_VERSION');
  }
  return document;
}

function wpText(record: RawRecord, field: string): string {
  return record.wp[field]?.trim() ?? '';
}

function normalizePublicId(value: string): number | null {
  if (!/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    && parsed < ZEROPRESS_NATIVE_PUBLIC_ID_BASE
    ? parsed
    : null;
}

function parseGmtDate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u.exec(
    value.trim(),
  );
  if (!match || match[1] === '0000') return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const values = [yearText, monthText, dayText, hourText, minuteText, secondText]
    .map(Number);
  const [year, month, day, hour, minute, second] = values;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
  ) return null;
  return date.toISOString().replace(/\.000Z$/u, 'Z');
}

function parseWxrWallClockMilliseconds(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u.exec(
    value.trim(),
  );
  if (!match || match[1] === '0000') return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
  ].map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
  ) return null;
  return date.getTime();
}

function inferWxrUtcOffsetMinutes(
  localValue: string,
  gmtValue: string,
): number | null {
  const local = parseWxrWallClockMilliseconds(localValue);
  const gmt = parseWxrWallClockMilliseconds(gmtValue);
  if (local === null || gmt === null) return null;
  const difference = local - gmt;
  if (difference % 60_000 !== 0) return null;
  const minutes = difference / 60_000;
  return Math.abs(minutes) <= 14 * 60 ? minutes : null;
}

function formatUtcOffsetTimezone(offsetMinutes: number): string {
  if (offsetMinutes === 0 || Object.is(offsetMinutes, -0)) return 'UTC';
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(
    absolute % 60,
  ).padStart(2, '0')}`;
}

function isTimezoneEvidenceItem(item: RawItem): boolean {
  const type = wpText(item, 'post_type');
  return (type === 'post' || type === 'page')
    && wpText(item, 'status') === 'publish'
    && wpText(item, 'post_password') === ''
    && normalizePublicId(wpText(item, 'post_id')) !== null
    && parseGmtDate(wpText(item, 'post_date_gmt')) !== null
    && parseGmtDate(wpText(item, 'post_modified_gmt')) !== null;
}

function inferSiteTimezone(
  document: RawDocument,
  warnings: WarningAccumulator,
): string | null {
  const offsets = new Set<number>();
  for (const item of document.items) {
    if (!isTimezoneEvidenceItem(item)) continue;
    const offset = inferWxrUtcOffsetMinutes(
      wpText(item, 'post_date'),
      wpText(item, 'post_date_gmt'),
    );
    if (offset !== null) offsets.add(offset);
  }
  if (offsets.size === 1) {
    return formatUtcOffsetTimezone(offsets.values().next().value!);
  }
  if (offsets.size === 0) {
    warnings.add('timezone_inference_skipped', 'site:timezone');
    return null;
  }
  for (const offset of [...offsets].sort((left, right) => left - right)) {
    warnings.add('timezone_inference_ambiguous', formatUtcOffsetTimezone(offset));
  }
  return null;
}

type InferredPermalinks = WxrCoreImportPlan['source']['permalinks'];

function normalizePermalinkSlug(value: string): string {
  const source = normalizeStoredSlug(value);
  if (!source) return '';
  const normalized = source
    .trim()
    .replace(/[\s/\\%?#\u0000-\u001F\u007F]+/gu, '-')
    .replace(/\.{2,}/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[.-]+|[.-]+$/gu, '')
    .replace(/^-+|-+$/gu, '');
  if (!normalized) return '';
  const validation = validateSlugSegment(normalized);
  return validation.ok ? validation.normalized : generateContentSlug(normalized);
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function permalinkSourcePath(
  value: string,
  sourceSite: NonNullable<ReturnType<typeof sourceNavigationSite>>,
): string | null {
  try {
    const parsed = new URL(value.trim());
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || parsed.origin !== sourceSite.origin
    ) return null;
    return stripSourceBasePath(parsed.pathname || '/', sourceSite.basePath);
  } catch {
    return null;
  }
}

function wxrLocalDateParts(value: string): {
  year: string;
  month: string;
  day: string;
} | null {
  if (parseWxrWallClockMilliseconds(value) === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2}) /u.exec(value.trim());
  return match ? { year: match[1]!, month: match[2]!, day: match[3]! } : null;
}

function permalinkPatternForPath(input: {
  pathname: string;
  postType: 'post' | 'page';
  publicId: number;
  slug: string;
  localDateParts: ReturnType<typeof wxrLocalDateParts>;
}): string | null {
  const body = input.pathname.replace(/^\/+|\/+$/gu, '');
  if (!body) return null;
  const availableDateTokens = input.postType === 'post' && input.localDateParts
    ? [
        ['year', input.localDateParts.year],
        ['month', input.localDateParts.month],
        ['day', input.localDateParts.day],
      ] as Array<[string, string]>
    : [];
  let publicIdAvailable = input.postType === 'post';
  let slugAvailable = input.slug !== '';
  let hasPostIdentityToken = false;
  let hasPageSlugToken = false;
  const segments: string[] = [];

  for (const rawSegment of body.split('/')) {
    const decodedSegment = safeDecodeURIComponent(rawSegment);
    const normalizedSegment = normalizePermalinkSlug(decodedSegment);
    const matches: Array<{
      token: string;
      kind: 'public-id' | 'date' | 'slug';
      index?: number;
    }> = [];
    if (publicIdAvailable && decodedSegment === String(input.publicId)) {
      matches.push({ token: 'public_id', kind: 'public-id' });
    }
    for (let index = 0; index < availableDateTokens.length; index += 1) {
      const [token, value] = availableDateTokens[index]!;
      if (decodedSegment === value) matches.push({ token, kind: 'date', index });
    }
    if (slugAvailable && normalizedSegment === input.slug) {
      matches.push({ token: 'slug', kind: 'slug' });
    }
    if (matches.length !== 1) {
      if (matches.length > 1) return null;
      if (
        input.postType === 'post'
        && input.localDateParts === null
        && /^\d+$/u.test(decodedSegment)
      ) return null;
      if (!normalizedSegment) return null;
      segments.push(normalizedSegment);
      continue;
    }
    const match = matches[0]!;
    segments.push(`:${match.token}`);
    if (match.kind === 'public-id') {
      publicIdAvailable = false;
      hasPostIdentityToken = true;
    } else if (match.kind === 'date') {
      availableDateTokens.splice(match.index!, 1);
    } else {
      slugAvailable = false;
      if (input.postType === 'post') hasPostIdentityToken = true;
      else hasPageSlugToken = true;
    }
  }
  if (input.postType === 'post' && !hasPostIdentityToken) return null;
  if (input.postType === 'page' && !hasPageSlugToken) return null;
  return `/${segments.join('/')}/`;
}

function choosePermalinkPattern(candidates: readonly string[]): string | null {
  if (candidates.length === 0) return null;
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [candidate, count] of counts) {
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  if (!best) return null;
  const required = best.includes(':public_id')
    ? 1
    : Math.max(2, Math.ceil(candidates.length * 0.6));
  return bestCount >= required ? best : null;
}

function inferDocumentPermalinkPattern(
  items: readonly RawItem[],
  sourceSite: NonNullable<ReturnType<typeof sourceNavigationSite>>,
  postType: 'post' | 'page',
): string | null {
  const candidates: string[] = [];
  for (const item of items) {
    if (!isTimezoneEvidenceItem(item) || wpText(item, 'post_type') !== postType) {
      continue;
    }
    const pathname = permalinkSourcePath(item.link, sourceSite);
    if (!pathname) continue;
    const publicId = normalizePublicId(wpText(item, 'post_id'))!;
    const title = item.title.trim() || `${postType === 'post' ? 'Post' : 'Page'} ${publicId}`;
    const slug = normalizePermalinkSlug(wpText(item, 'post_name'))
      || generateContentSlug(title);
    const candidate = permalinkPatternForPath({
      pathname,
      postType,
      publicId,
      slug,
      localDateParts: wxrLocalDateParts(wpText(item, 'post_date')),
    });
    if (candidate) candidates.push(candidate);
  }
  return choosePermalinkPattern(candidates);
}

function inferPagePermalinkPattern(
  items: readonly RawItem[],
  sourceSite: NonNullable<ReturnType<typeof sourceNavigationSite>>,
): string | null {
  type PageEvidence = {
    id: number;
    parentId: number | null;
    slug: string;
    pathname: string | null;
  };
  const pages = new Map<number, PageEvidence>();
  for (const item of items) {
    if (!isTimezoneEvidenceItem(item) || wpText(item, 'post_type') !== 'page') continue;
    const id = normalizePublicId(wpText(item, 'post_id'))!;
    const title = item.title.trim() || `Page ${id}`;
    pages.set(id, {
      id,
      parentId: normalizePublicId(wpText(item, 'post_parent')),
      slug: normalizePermalinkSlug(wpText(item, 'post_name'))
        || generateContentSlug(title)
        || `page-${id}`,
      pathname: permalinkSourcePath(item.link, sourceSite),
    });
  }

  const candidates: string[] = [];
  for (const page of pages.values()) {
    if (!page.pathname) continue;
    const reversed: string[] = [];
    const seen = new Set<number>();
    let current: PageEvidence | undefined = page;
    while (current) {
      if (seen.has(current.id)) {
        reversed.length = 0;
        break;
      }
      seen.add(current.id);
      reversed.push(current.slug);
      current = current.parentId === null ? undefined : pages.get(current.parentId);
    }
    if (reversed.length === 0) continue;
    const lineage = reversed.reverse();
    const segments = page.pathname
      .replace(/^\/+|\/+$/gu, '')
      .split('/')
      .map((segment) => normalizePermalinkSlug(safeDecodeURIComponent(segment)));
    if (segments.some((segment) => !segment)) continue;
    let matchIndex = -1;
    for (let start = 0; start <= segments.length - lineage.length; start += 1) {
      if (lineage.every((slug, offset) => segments[start + offset] === slug)) {
        matchIndex = start;
      }
    }
    if (matchIndex < 0) continue;
    candidates.push(`/${[
      ...segments.slice(0, matchIndex),
      ':slug',
      ...segments.slice(matchIndex + lineage.length),
    ].join('/')}/`);
  }
  return choosePermalinkPattern(candidates);
}

function inferPermalinks(
  items: readonly RawItem[],
  sourceSiteUrl: string,
): InferredPermalinks {
  const sourceSite = sourceNavigationSite(sourceSiteUrl);
  if (!sourceSite) return { output_style: null, posts: null, pages: null };
  let directory = 0;
  let htmlExtension = 0;
  for (const item of items) {
    if (!isTimezoneEvidenceItem(item)) continue;
    const pathname = permalinkSourcePath(item.link, sourceSite);
    if (!pathname || pathname === '/') continue;
    if (pathname.endsWith('/')) directory += 1;
    else htmlExtension += 1;
  }
  return {
    output_style: directory === 0 && htmlExtension === 0
      ? null
      : htmlExtension >= directory ? 'html-extension' : 'directory',
    posts: inferDocumentPermalinkPattern(items, sourceSite, 'post'),
    pages: inferPagePermalinkPattern(items, sourceSite),
  };
}

function normalizeSourceSiteUrl(value: string): {
  source: string;
  origin: string;
} | null {
  const source = value.trim();
  if (
    !source
    || source !== value
    || /[\s\\\p{Cc}]/u.test(source)
    || /%(?![0-9A-Fa-f]{2})/u.test(source)
  ) return null;
  try {
    const parsed = new URL(source);
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) return null;
    const origin = normalizeSiteOrigin(parsed.origin);
    return origin === null ? null : { source, origin };
  } catch {
    return null;
  }
}

function compactText(value: string, maximum: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maximum ? trimmed : trimmed.slice(0, maximum).trim();
}

function firstPostMetaValue(
  item: RawItem,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = item.postmeta[key]?.trim() ?? '';
    if (value) return value;
  }
  return '';
}

function compactImportedCommentWhitespace(value: string): string {
  return value
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/\n+/gu, '\n')
    .trim();
}

function normalizeSlug(value: string, fallback: string): string {
  const source = normalizeStoredSlug(value || fallback)
    .trim()
    .replace(/[\s/\\%?#\u0000-\u001F\u007F]+/gu, '-')
    .replace(/\.{2,}/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[.-]+|[.-]+$/gu, '');
  const validation = validateSlugSegment(source);
  if (validation.ok) return validation.normalized;
  const generated = generateContentSlug(source || fallback);
  const generatedValidation = validateSlugSegment(generated);
  if (!generatedValidation.ok) throw new WxrCoreParseError('INVALID_WXR');
  return generatedValidation.normalized;
}

function suffixSlug(base: string, suffix: string): string {
  const allowance = Math.max(1, 200 - suffix.length - 1);
  return `${[...base].slice(0, allowance).join('').replace(/[.-]+$/gu, '')}-${suffix}`;
}

function reserveSlug(input: {
  base: string;
  publicId: number;
  scope: string;
  reserved: Set<string>;
  warnings: WarningAccumulator;
  label: string;
}): string {
  const reserve = (candidate: string) => {
    const key = `${input.scope}\u0000${candidate}`;
    if (input.reserved.has(key)) return false;
    input.reserved.add(key);
    return true;
  };
  if (reserve(input.base)) return input.base;
  const withId = suffixSlug(input.base, String(input.publicId));
  if (reserve(withId)) {
    input.warnings.add('resolved_slug_conflicts', input.label);
    return withId;
  }
  for (let index = 2; index < MAX_UNIQUE_SUFFIX_ATTEMPTS; index += 1) {
    const candidate = suffixSlug(withId, String(index));
    if (reserve(candidate)) {
      input.warnings.add('resolved_slug_conflicts', input.label);
      return candidate;
    }
  }
  throw new WxrCoreParseError('INVALID_WXR');
}

function attachmentMetadata(raw: string): {
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { width: null, height: null, sizeBytes: null };
  let width: number | undefined;
  let height: number | undefined;
  let sizeBytes: number | undefined;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (Number.isSafeInteger(parsed.width)) width = Number(parsed.width);
      if (Number.isSafeInteger(parsed.height)) height = Number(parsed.height);
      if (Number.isSafeInteger(parsed.filesize)) sizeBytes = Number(parsed.filesize);
    } catch {
      return { width: null, height: null, sizeBytes: null };
    }
  } else {
    const widthMatch = /(?:^|[;{])s:5:"width";i:(\d+);/u.exec(trimmed);
    const heightMatch = /(?:^|[;{])s:6:"height";i:(\d+);/u.exec(trimmed);
    const sizeMatch = /(?:^|[;{])s:8:"filesize";i:(\d+);/u.exec(trimmed);
    if (widthMatch) width = Number(widthMatch[1]);
    if (heightMatch) height = Number(heightMatch[1]);
    if (sizeMatch) sizeBytes = Number(sizeMatch[1]);
  }
  const validDimensions = Number.isSafeInteger(width)
    && Number.isSafeInteger(height)
    && width! >= 1
    && height! >= 1
    && width! <= MEDIA_DIMENSION_MAX
    && height! <= MEDIA_DIMENSION_MAX;
  return {
    width: validDimensions ? width! : null,
    height: validDimensions ? height! : null,
    sizeBytes: Number.isSafeInteger(sizeBytes) && sizeBytes! >= 0
      ? sizeBytes!
      : null,
  };
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '7z': 'application/x-7z-compressed',
  gz: 'application/gzip',
  rar: 'application/vnd.rar',
  tar: 'application/x-tar',
  zip: 'application/zip',
};

function filenameFromPath(value: string): string | null {
  let pathname = value;
  try {
    pathname = new URL(value).pathname;
  } catch {
    // The fallback also handles WordPress relative attachment paths.
  }
  const raw = pathname.split('/').at(-1) ?? '';
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return normalizeMediaFilename(decoded);
}

function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]+)$/u.exec(filename);
  return match?.[1]?.toLowerCase() ?? '';
}

function inferMimeType(raw: string, filename: string): string {
  return normalizeMediaMimeType(raw) ?? MIME_BY_EXTENSION[extensionOf(filename)]
    ?? 'application/octet-stream';
}

function inferMediaKind(mimeType: string, filename: string): WxrImportMediaRow['kind'] {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extensionOf(filename))) {
    return 'archive';
  }
  if (
    mimeType === 'application/pdf'
    || mimeType.startsWith('text/')
    || /(?:document|msword|officedocument|presentation|spreadsheet|excel)/u
      .test(mimeType)
  ) return 'document';
  return 'other';
}

function normalizeMediaPrefix(value: string): string | null {
  const trimmed = value.trim();
  if (
    trimmed === ''
    || /[\s\\\p{Cc}]/u.test(trimmed)
    || /%(?![0-9A-Fa-f]{2})/u.test(trimmed)
  ) return null;
  const suffix = trimmed.slice(trimmed.indexOf('://') + 3);
  const pathStart = suffix.indexOf('/');
  const rawPath = pathStart < 0 ? '/' : suffix.slice(pathStart);
  for (const segment of rawPath.split('/')) {
    if (!segment) continue;
    try {
      const decoded = decodeURIComponent(segment);
      if (decoded === '.' || decoded === '..') return null;
    } catch {
      return null;
    }
  }
  try {
    const parsed = new URL(trimmed);
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.hostname === ''
      || parsed.search
      || parsed.hash
    ) return null;
    const href = parsed.href.replace(/\/+$/u, '');
    return `${href}/`;
  } catch {
    return null;
  }
}

function inferWordPressMediaPrefix(document: RawDocument): string | null {
  const candidates = new Set<string>();
  for (const item of document.items) {
    if (wpText(item, 'post_type') !== 'attachment') continue;
    const source = normalizeExternalMediaUrl(wpText(item, 'attachment_url'));
    if (!source) continue;
    const parsed = new URL(source);
    const marker = '/wp-content/uploads/';
    const markerIndex = parsed.pathname.indexOf(marker);
    if (markerIndex < 0) continue;
    candidates.add(`${parsed.origin}${parsed.pathname.slice(0, markerIndex + marker.length)}`);
  }
  return candidates.size === 1 ? [...candidates][0]! : null;
}

function importedStorageKey(input: {
  source: string;
  attachedFile: string;
  mediaFrom: string;
}): string | null {
  const attached = normalizeMediaStorageKey(input.attachedFile);
  if (attached) return normalizeMediaStorageKey(`imported/${attached}`);
  if (!input.source.startsWith(input.mediaFrom)) return null;
  const relative = input.source.slice(input.mediaFrom.length).split(/[?#]/u, 1)[0];
  return normalizeMediaStorageKey(`imported/${relative}`);
}

function rewriteManagedMediaText(input: {
  value: string;
  mediaFrom: string;
  exact: ReadonlyMap<string, string>;
}): string {
  let value = input.value.split(input.mediaFrom)
    .join(`${MANAGED_MEDIA_REFERENCE_PREFIX}imported/`);
  for (const [source, reference] of [...input.exact.entries()].sort(
    (left, right) => right[0].length - left[0].length,
  )) {
    value = value.split(source).join(reference);
  }
  return value;
}

function allocateAuthorId(
  base: string,
  wpId: string,
  used: Set<string>,
): string {
  const candidate = suggestAuthorId(base) || 'author';
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  const normalizedWpId = normalizePublicId(wpId);
  if (normalizedWpId) {
    const withId = `${candidate}-${normalizedWpId}`;
    if (!used.has(withId)) {
      used.add(withId);
      return withId;
    }
  }
  for (let suffix = 2; suffix < MAX_UNIQUE_SUFFIX_ATTEMPTS; suffix += 1) {
    const value = `${candidate}-${suffix}`;
    if (!used.has(value)) {
      used.add(value);
      return value;
    }
  }
  throw new WxrCoreParseError('INVALID_WXR');
}

type ImportedNavMenuTerm = {
  wpId: string;
  rawSlug: string;
  sourceSlug: string;
  slug: string;
  name: string;
  order: number;
};

type ImportedNavMenuSlugSource = {
  wpId: string;
  rawSlug: string;
  sourceSlug: string;
  slug: string;
  name: string;
};

type ImportedNavMenuItem = {
  publicId: number;
  parentPublicId: number | null;
  menuSlugs: string[];
  order: number;
  title: string;
  itemType: string;
  objectType: string;
  objectId: string;
  target: '_self' | '_blank';
  url: string;
  label: string;
};

function normalizeImportedMenuId(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64);
  if (/^[a-z][a-z0-9_-]{0,63}$/u.test(normalized)) return normalized;
  const normalizedFallback = fallback
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 59);
  return `menu-${normalizedFallback || 'imported'}`.slice(0, 64);
}

function isPreferredPrimaryMenu(slug: string, name: string): boolean {
  return /\b(primary|main|menu-1|topmenu|top-menu|header|navigation|nav)\b/u
    .test(`${slug} ${name}`.toLowerCase());
}

function isPreferredFooterMenu(slug: string, name: string): boolean {
  return /\b(footer|bottom)\b/u.test(`${slug} ${name}`.toLowerCase());
}

function assignImportedMenuIds(
  terms: ImportedNavMenuTerm[],
  activeSlugs: ReadonlySet<string>,
): Map<string, string> {
  const assignments = new Map<string, string>();
  const used = new Set<string>();
  const activeTerms = terms.filter((term) => activeSlugs.has(term.slug));
  const primary = activeTerms.find((term) => (
    isPreferredPrimaryMenu(term.slug, term.name)
  )) ?? activeTerms[0];
  const footer = activeTerms.find((term) => (
    term !== primary && isPreferredFooterMenu(term.slug, term.name)
  ));

  const assign = (term: ImportedNavMenuTerm, preferred: string) => {
    const base = used.has(preferred)
      ? normalizeImportedMenuId(term.slug || term.name, `menu-${term.order + 1}`)
      : preferred;
    if (!used.has(base)) {
      used.add(base);
      assignments.set(term.slug, base);
      return;
    }
    for (let suffix = 2; suffix < MAX_UNIQUE_SUFFIX_ATTEMPTS; suffix += 1) {
      const candidate = `${base.slice(0, 60)}-${suffix}`;
      if (used.has(candidate)) continue;
      used.add(candidate);
      assignments.set(term.slug, candidate);
      return;
    }
    throw new WxrCoreParseError('INVALID_WXR');
  };

  if (primary) assign(primary, 'primary');
  if (footer) assign(footer, 'footer');
  for (const term of activeTerms) {
    if (!assignments.has(term.slug)) {
      assign(
        term,
        normalizeImportedMenuId(term.slug || term.name, `menu-${term.order + 1}`),
      );
    }
  }
  return assignments;
}

function sourceNavigationSite(value: string): {
  origin: string;
  basePath: string;
} | null {
  try {
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || !parsed.hostname
    ) return null;
    return {
      origin: parsed.origin,
      basePath: parsed.pathname.replace(/\/+$/u, '') || '/',
    };
  } catch {
    return null;
  }
}

function stripSourceBasePath(pathname: string, basePath: string): string {
  if (basePath === '/') return pathname;
  if (pathname === basePath || pathname === `${basePath}/`) return '/';
  return pathname.startsWith(`${basePath}/`)
    ? pathname.slice(basePath.length)
    : pathname;
}

function normalizeImportedMenuUrl(
  value: string,
  sourceSite: ReturnType<typeof sourceNavigationSite>,
): string | null {
  const trimmed = value.trim();
  if (
    !trimmed
    || /[\s\\\p{Cc}]/u.test(trimmed)
    || /%(?![0-9A-Fa-f]{2})/u.test(trimmed)
    || trimmed.startsWith('//')
  ) return null;
  let candidate: string;
  if (trimmed.startsWith('#')) {
    candidate = `/${trimmed}`;
  } else if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    const suffixIndex = trimmed.search(/[?#]/u);
    const pathname = suffixIndex === -1 ? trimmed : trimmed.slice(0, suffixIndex);
    const suffix = suffixIndex === -1 ? '' : trimmed.slice(suffixIndex);
    candidate = `${stripSourceBasePath(pathname || '/', sourceSite?.basePath ?? '/')}${suffix}`;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || !parsed.hostname
    ) return null;
    candidate = sourceSite && parsed.origin === sourceSite.origin
      ? `${stripSourceBasePath(parsed.pathname || '/', sourceSite.basePath)}${parsed.search}${parsed.hash}`
      : parsed.href;
  }
  const parsed = menuCustomUrlSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function importedMenuItemId(publicId: number): string {
  return publicId.toString(16).padStart(32, '0');
}

function findCyclicMenuItems(
  orderedIds: number[],
  parents: ReadonlyMap<number, number | null>,
): Set<number> {
  const safe = new Set<number>();
  const cyclic = new Set<number>();
  for (const start of orderedIds) {
    if (safe.has(start) || cyclic.has(start)) continue;
    const path: number[] = [];
    const pathIndexes = new Map<number, number>();
    let current: number | null = start;
    let reachesCycle = false;
    while (current !== null) {
      if (cyclic.has(current)) {
        reachesCycle = true;
        break;
      }
      if (safe.has(current)) break;
      if (pathIndexes.has(current)) {
        reachesCycle = true;
        break;
      }
      pathIndexes.set(current, path.length);
      path.push(current);
      current = parents.get(current) ?? null;
    }
    const destination = reachesCycle ? cyclic : safe;
    for (const id of path) destination.add(id);
  }
  return cyclic;
}

function calculateMenuDepths(
  orderedIds: number[],
  parents: ReadonlyMap<number, number | null>,
): Map<number, number> {
  const depths = new Map<number, number>();
  for (const start of orderedIds) {
    if (depths.has(start)) continue;
    const path: number[] = [];
    let current: number | null = start;
    while (current !== null && !depths.has(current)) {
      path.push(current);
      current = parents.get(current) ?? null;
    }
    let depth = current === null ? 0 : depths.get(current) ?? 0;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      depth += 1;
      depths.set(path[index]!, depth);
    }
  }
  return depths;
}

function cloneImportedMenuItem(item: WxrImportMenuItem): WxrImportMenuItem {
  return {
    ...item,
    link: { ...item.link },
    children: [],
  };
}

function isSameImportedMenuTerm(
  left: ImportedNavMenuSlugSource,
  right: ImportedNavMenuSlugSource,
): boolean {
  return left.wpId === right.wpId
    && left.rawSlug === right.rawSlug
    && left.sourceSlug === right.sourceSlug
    && left.slug === right.slug
    && left.name === right.name;
}

function buildImportedMenus(input: {
  document: RawDocument;
  posts: readonly WxrImportPostRow[];
  pages: readonly WxrImportPageRow[];
  categoryByWpId: ReadonlyMap<string, { slug: string; name: string }>;
  tagByWpId: ReadonlyMap<string, { slug: string; name: string }>;
  sourceSiteUrl: string;
  warnings: WarningAccumulator;
}): WxrImportMenuRow[] {
  const sourceSite = sourceNavigationSite(input.sourceSiteUrl);
  const posts = new Map(input.posts.map((post) => [post.public_id, post]));
  const pages = new Map(input.pages.map((page) => [page.public_id, page]));
  const terms: ImportedNavMenuTerm[] = [];
  const termBySlug = new Map<string, ImportedNavMenuTerm>();
  const termSourceByWpId = new Map<string, ImportedNavMenuSlugSource>();
  const slugSourceBySlug = new Map<string, ImportedNavMenuSlugSource>();
  for (const raw of input.document.terms) {
    if (wpText(raw, 'term_taxonomy') !== 'nav_menu') continue;
    const wpId = wpText(raw, 'term_id');
    const rawSlug = wpText(raw, 'term_slug');
    const rawName = wpText(raw, 'term_name');
    if (!rawSlug && !rawName) continue;
    const sourceSlug = rawSlug || rawName;
    const slug = normalizeSlug(sourceSlug, 'menu');
    const source = { wpId, rawSlug, sourceSlug, slug, name: rawName };
    const previousByWpId = wpId ? termSourceByWpId.get(wpId) : undefined;
    if (previousByWpId) {
      if (isSameImportedMenuTerm(previousByWpId, source)) continue;
      throw new WxrCoreParseError('INVALID_WXR');
    }
    const previousBySlug = slugSourceBySlug.get(slug);
    if (previousBySlug) {
      if (isSameImportedMenuTerm(previousBySlug, source)) continue;
      throw new WxrCoreParseError('INVALID_WXR');
    }
    const name = compactText(rawName || slug, MENU_NAME_MAX_LENGTH);
    const term = {
      wpId,
      rawSlug,
      sourceSlug,
      slug,
      name,
      order: terms.length,
    };
    terms.push(term);
    termBySlug.set(slug, term);
    if (wpId) termSourceByWpId.set(wpId, source);
    slugSourceBySlug.set(slug, source);
  }

  const rawItems: ImportedNavMenuItem[] = [];
  const converted = new Map<number, WxrImportMenuItem>();
  const seenIds = new Set<number>();
  const menuNameHints = new Map<string, string>();
  for (const item of input.document.items) {
    if (wpText(item, 'post_type') !== 'nav_menu_item') continue;
    const idText = wpText(item, 'post_id');
    const publicId = normalizePublicId(idText);
    const label = `menu item ${idText || compactText(item.title, MENU_ITEM_TITLE_MAX_LENGTH) || 'unknown'}`;
    if (!publicId) {
      input.warnings.add('skipped_menu_items', label);
      continue;
    }
    if (seenIds.has(publicId)) throw new WxrCoreParseError('DUPLICATE_PUBLIC_ID');
    seenIds.add(publicId);
    if (wpText(item, 'status') !== 'publish') {
      input.warnings.add('skipped_menu_items', label);
      continue;
    }
    const menuSlugs: string[] = [];
    for (const category of item.categories) {
      if (category.domain !== 'nav_menu') continue;
      const sourceSlug = category.nicename.trim();
      if (!sourceSlug) continue;
      const slug = normalizeSlug(sourceSlug, sourceSlug);
      const previousSource = slugSourceBySlug.get(slug);
      if (previousSource && previousSource.sourceSlug !== sourceSlug) {
        throw new WxrCoreParseError('INVALID_WXR');
      }
      if (!previousSource) {
        slugSourceBySlug.set(slug, {
          wpId: '',
          rawSlug: sourceSlug,
          sourceSlug,
          slug,
          name: category.text.trim(),
        });
      }
      if (!menuSlugs.includes(slug)) menuSlugs.push(slug);
      if (!menuNameHints.has(slug)) {
        menuNameHints.set(slug, compactText(category.text || slug, MENU_NAME_MAX_LENGTH));
      }
    }
    if (menuSlugs.length === 0) {
      input.warnings.add('skipped_menu_items', label);
      continue;
    }
    const parentText = item.postmeta._menu_item_menu_item_parent?.trim() ?? '';
    const hasParent = parentText !== '' && parentText !== '0';
    const parentPublicId = hasParent ? normalizePublicId(parentText) : null;
    if (hasParent && parentPublicId === null) {
      input.warnings.add('orphan_menu_parents', label);
    }
    const order = Number.parseInt(wpText(item, 'menu_order'), 10);
    const rawItem: ImportedNavMenuItem = {
      publicId,
      parentPublicId,
      menuSlugs,
      order: Number.isSafeInteger(order) && order >= 0 ? order : 0,
      title: item.title,
      itemType: item.postmeta._menu_item_type?.trim() ?? '',
      objectType: item.postmeta._menu_item_object?.trim() ?? '',
      objectId: item.postmeta._menu_item_object_id?.trim() ?? '',
      target: item.postmeta._menu_item_target?.trim() === '_blank'
        ? '_blank'
        : '_self',
      url: item.postmeta._menu_item_url?.trim() ?? '',
      label,
    };
    rawItems.push(rawItem);

    const rawTitle = rawItem.title.trim();
    const explicitTitle = compactText(rawTitle, MENU_ITEM_TITLE_MAX_LENGTH);
    if (explicitTitle !== rawTitle) input.warnings.add('truncated_fields', label);
    const fallbackUrl = normalizeImportedMenuUrl(rawItem.url, sourceSite);
    let link: WxrImportMenuItem['link'] | null = null;
    let fallbackTitle = '';
    if (rawItem.itemType === 'custom') {
      if (fallbackUrl) link = { kind: 'custom', url: fallbackUrl };
    } else if (rawItem.itemType === 'post_type' && rawItem.objectType === 'post') {
      const targetId = normalizePublicId(rawItem.objectId);
      const target = targetId ? posts.get(targetId) : undefined;
      if (target) {
        link = { kind: 'post', public_id: target.public_id };
        fallbackTitle = target.title;
      }
    } else if (rawItem.itemType === 'post_type' && rawItem.objectType === 'page') {
      const targetId = normalizePublicId(rawItem.objectId);
      const target = targetId ? pages.get(targetId) : undefined;
      if (target) {
        link = { kind: 'page', public_id: target.public_id };
        fallbackTitle = target.title;
      }
    } else if (
      rawItem.itemType === 'taxonomy'
      && rawItem.objectType === 'category'
    ) {
      const target = input.categoryByWpId.get(rawItem.objectId);
      if (target) {
        link = { kind: 'category', slug: target.slug };
        fallbackTitle = target.name;
      }
    } else if (
      rawItem.itemType === 'taxonomy'
      && rawItem.objectType === 'post_tag'
    ) {
      const target = input.tagByWpId.get(rawItem.objectId);
      if (target) {
        link = { kind: 'tag', slug: target.slug };
        fallbackTitle = target.name;
      }
    }
    if (!link && fallbackUrl && explicitTitle) {
      link = { kind: 'custom', url: fallbackUrl };
    }
    const title = explicitTitle || compactText(
      fallbackTitle,
      MENU_ITEM_TITLE_MAX_LENGTH,
    );
    if (!link || !title) {
      input.warnings.add('skipped_menu_items', label);
      continue;
    }
    converted.set(publicId, {
      id: importedMenuItemId(publicId),
      title,
      link,
      target: rawItem.target,
      children: [],
    });
  }

  const activeSlugs = new Set(rawItems.flatMap((item) => item.menuSlugs));
  for (const slug of activeSlugs) {
    if (termBySlug.has(slug)) continue;
    const term = {
      wpId: '',
      rawSlug: slug,
      sourceSlug: slug,
      slug,
      name: menuNameHints.get(slug) || slug,
      order: terms.length,
    };
    terms.push(term);
    termBySlug.set(slug, term);
  }
  const assignments = assignImportedMenuIds(terms, activeSlugs);
  const menus: WxrImportMenuRow[] = [];
  for (const [menuSlug, menuId] of assignments) {
    const menuItems = rawItems
      .filter((item) => item.menuSlugs.includes(menuSlug))
      .sort((left, right) => (
        left.order - right.order
        || (left.title < right.title ? -1 : left.title > right.title ? 1 : 0)
        || left.publicId - right.publicId
      ));
    const itemsById = new Map<number, WxrImportMenuItem>();
    const parents = new Map<number, number | null>();
    for (const raw of menuItems) {
      const item = converted.get(raw.publicId);
      if (!item || itemsById.has(raw.publicId)) continue;
      itemsById.set(raw.publicId, cloneImportedMenuItem(item));
      parents.set(raw.publicId, raw.parentPublicId);
    }
    const orderedIds = menuItems
      .map((item) => item.publicId)
      .filter((id, index, values) => (
        itemsById.has(id) && values.indexOf(id) === index
      ));
    for (const id of orderedIds) {
      const parent = parents.get(id) ?? null;
      if (parent !== null && !itemsById.has(parent)) {
        parents.set(id, null);
        input.warnings.add('orphan_menu_parents', `menu item ${id}`);
      }
    }
    const cyclic = findCyclicMenuItems(orderedIds, parents);
    for (const id of cyclic) {
      input.warnings.add('discarded_cyclic_menu_items', `menu item ${id}`);
    }
    const acyclic = orderedIds.filter((id) => !cyclic.has(id));
    const depths = calculateMenuDepths(acyclic, parents);
    const deep = new Set(acyclic.filter((id) => (
      (depths.get(id) ?? 1) > MENU_MAX_DEPTH
    )));
    for (const id of deep) {
      input.warnings.add('discarded_deep_menu_items', `menu item ${id}`);
    }
    const retained = acyclic.filter((id) => !deep.has(id));
    const retainedSet = new Set(retained);
    if (retained.length > MENU_MAX_ITEMS) {
      input.warnings.add('content_limits_skipped', termBySlug.get(menuSlug)?.name ?? menuId);
      continue;
    }
    const tree: WxrImportMenuItem[] = [];
    for (const id of retained) {
      const item = itemsById.get(id)!;
      const parent = parents.get(id) ?? null;
      if (parent !== null && retainedSet.has(parent)) {
        itemsById.get(parent)!.children.push(item);
      } else {
        tree.push(item);
      }
    }
    if (tree.length === 0) continue;
    if (menus.length >= MENU_MAX_COUNT) {
      input.warnings.add('content_limits_skipped', termBySlug.get(menuSlug)?.name ?? menuId);
      continue;
    }
    const name = compactText(
      termBySlug.get(menuSlug)?.name || menuSlug,
      MENU_NAME_MAX_LENGTH,
    );
    const row = { menu_id: menuId, name, items: tree };
    if (
      new TextEncoder().encode(JSON.stringify(tree)).byteLength
        > MENU_ITEMS_JSON_MAX_BYTES
      || !wxrImportMenuRowSchema.safeParse(row).success
    ) {
      input.warnings.add('content_limits_skipped', name || menuId);
      continue;
    }
    menus.push(row);
  }
  return menus.sort((left, right) => (
    left.menu_id < right.menu_id ? -1 : left.menu_id > right.menu_id ? 1 : 0
  ));
}

function createPlan(
  document: RawDocument,
  options: WxrCoreParserOptions = {},
): WxrCoreImportPlan {
  const warnings = new WarningAccumulator();
  const editorCompatibility = {
    visual: 0,
    source: 0,
    fallbacks: new Map<TiptapFallbackReason, {
      count: number;
      affected: string[];
    }>(),
  };
  const classifyImportedContent = (content: string, label: string) => {
    const result = classifyTiptapHtml(content);
    if (result.compatible) {
      editorCompatibility.visual += 1;
      return {
        content: result.canonicalHtml,
        editor_mode: 'visual' as const,
        editor_profile: 'tiptap-v1' as const,
      };
    }
    editorCompatibility.source += 1;
    for (const reason of result.reasons) {
      const current = editorCompatibility.fallbacks.get(reason) ?? {
        count: 0,
        affected: [],
      };
      current.count += 1;
      if (current.affected.length < MAX_WARNING_AFFECTED) {
        current.affected.push(normalizeWarningLabel(label));
      }
      editorCompatibility.fallbacks.set(reason, current);
    }
    return {
      content,
      editor_mode: 'source' as const,
      editor_profile: null,
    };
  };
  const sourceSiteUrls = [
    wpText(document.channel, 'base_blog_url'),
    document.channel.link.trim(),
    wpText(document.channel, 'base_site_url'),
  ].filter(Boolean);
  const sourceSiteUrlCandidate = sourceSiteUrls
    .map(normalizeSourceSiteUrl)
    .find((value) => value !== null) ?? null;
  const sourceSiteUrl = sourceSiteUrlCandidate?.source
    ?? sourceSiteUrls[0]
    ?? '';
  const siteLocale = normalizeSiteLocale(document.channel.language);
  if (siteLocale === null) {
    warnings.add('locale_inference_skipped', 'site:locale');
  }
  const siteSettings = {
    title: normalizeSiteTitle(document.channel.title),
    description: document.channelTextFields.has('description')
      ? normalizeSiteDescription(document.channel.description)
      : null,
    url: sourceSiteUrlCandidate,
    locale: siteLocale,
    timezone: inferSiteTimezone(document, warnings),
  };
  const permalinks = inferPermalinks(
    document.items,
    sourceSiteUrlCandidate?.source ?? '',
  );
  const mediaStrategy = options.mediaStrategy ?? 'external';
  const explicitMediaFrom = options.mediaFrom?.trim() ?? '';
  const mediaFrom = mediaStrategy === 'r2'
    ? (explicitMediaFrom
        ? normalizeMediaPrefix(explicitMediaFrom)
        : inferWordPressMediaPrefix(document))
    : null;
  if (mediaStrategy === 'r2' && explicitMediaFrom && !mediaFrom) {
    throw new WxrCoreParseError('MEDIA_PREFIX_INVALID');
  }
  if (mediaStrategy === 'r2' && !mediaFrom) {
    throw new WxrCoreParseError('MEDIA_PREFIX_REQUIRED');
  }
  for (const [type, count] of document.unsupportedItemTypes) {
    warnings.addCount('unsupported_items_skipped', type, count);
  }
  const authorByLogin = new Map<string, WxrImportAuthorRow>();
  const usedAuthorIds = new Set<string>();
  for (const raw of document.authors) {
    const login = wpText(raw, 'author_login');
    const rawDisplay = wpText(raw, 'author_display_name') || login;
    if (!login && !rawDisplay) continue;
    if (authorByLogin.has(login || rawDisplay)) continue;
    const id = allocateAuthorId(login || rawDisplay, wpText(raw, 'author_id'), usedAuthorIds);
    authorByLogin.set(login || rawDisplay, {
      id,
      display_name: compactText(rawDisplay || login, AUTHOR_DISPLAY_NAME_MAX_LENGTH),
    });
  }

  const resolveAuthor = (creator: string): WxrImportAuthorRow => {
    const key = creator.trim();
    const existing = authorByLogin.get(key);
    if (existing) return existing;
    if (!key) {
      const unknown = authorByLogin.get('');
      if (unknown) return unknown;
      const value = {
        id: allocateAuthorId('wordpress-unknown', '', usedAuthorIds),
        display_name: 'Unknown WordPress Author',
      };
      authorByLogin.set('', value);
      warnings.add('synthesized_authors', value.display_name);
      return value;
    }
    const value = {
      id: allocateAuthorId(key, '', usedAuthorIds),
      display_name: compactText(key, AUTHOR_DISPLAY_NAME_MAX_LENGTH),
    };
    authorByLogin.set(key, value);
    warnings.add('synthesized_authors', key);
    return value;
  };

  const categories = new Map<string, WxrImportCategoryRow>();
  const tags = new Map<string, WxrImportTagRow>();
  const categoryByWpId = new Map<string, { slug: string; name: string }>();
  const tagByWpId = new Map<string, { slug: string; name: string }>();
  const addTaxonomy = (
    target: Map<string, WxrImportCategoryRow | WxrImportTagRow>,
    rawSlug: string,
    rawName: string,
    rawDescription: string,
    synthesized: boolean,
  ) => {
    const name = compactText(rawName || rawSlug, 200);
    if (!name) return '';
    const slug = normalizeSlug(rawSlug, name);
    if (!target.has(slug)) {
      target.set(slug, {
        name,
        slug,
        description: compactText(rawDescription, 10_000),
      });
      if (synthesized) warnings.add('synthesized_taxonomies', slug);
    }
    return slug;
  };
  for (const raw of document.categories) {
    const slug = addTaxonomy(
      categories,
      wpText(raw, 'category_nicename'),
      wpText(raw, 'cat_name'),
      wpText(raw, 'category_description'),
      false,
    );
    const wpId = wpText(raw, 'term_id');
    if (wpId && slug) {
      const target = { slug, name: categories.get(slug)!.name };
      const current = categoryByWpId.get(wpId);
      if (current && current.slug !== target.slug) {
        throw new WxrCoreParseError('INVALID_WXR');
      }
      categoryByWpId.set(wpId, target);
    }
  }
  for (const raw of document.tags) {
    const slug = addTaxonomy(
      tags,
      wpText(raw, 'tag_slug'),
      wpText(raw, 'tag_name'),
      wpText(raw, 'tag_description'),
      false,
    );
    const wpId = wpText(raw, 'term_id');
    if (wpId && slug) {
      const target = { slug, name: tags.get(slug)!.name };
      const current = tagByWpId.get(wpId);
      if (current && current.slug !== target.slug) {
        throw new WxrCoreParseError('INVALID_WXR');
      }
      tagByWpId.set(wpId, target);
    }
  }

  const media: WxrImportMediaRow[] = [];
  const attachmentLocationByWpId = new Map<number, MediaLocation>();
  const mediaBySource = new Map<string, WxrImportMediaRow>();
  const mediaExternalIdsBySource = new Map<string, Set<number>>();
  const managedExactRewrites = new Map<string, string>();
  for (const item of document.items) {
    if (wpText(item, 'post_type') !== 'attachment') continue;
    const wpId = wpText(item, 'post_id');
    const externalId = normalizePublicId(wpId);
    const label = compactText(item.title, POST_TITLE_MAX_LENGTH) || wpId || 'attachment';
    const source = normalizeExternalMediaUrl(wpText(item, 'attachment_url'));
    if (externalId === null || !source) {
      warnings.add('media_metadata_skipped', label);
      continue;
    }
    const attachedFile = item.postmeta._wp_attached_file ?? '';
    const filename = filenameFromPath(attachedFile)
      ?? filenameFromPath(source)
      ?? normalizeMediaFilename(label)
      ?? `attachment-${wpId}`;
    const mimeType = inferMimeType(wpText(item, 'post_mime_type'), filename);
    const kind = inferMediaKind(mimeType, filename);
    const metadata = attachmentMetadata(
      item.postmeta._wp_attachment_metadata ?? '',
    );
    let location: MediaLocation;
    if (mediaStrategy === 'r2') {
      const key = importedStorageKey({
        source,
        attachedFile,
        mediaFrom: mediaFrom!,
      });
      if (!key) {
        warnings.add('media_metadata_skipped', label);
        continue;
      }
      location = { type: 'r2', key };
      managedExactRewrites.set(source, createManagedMediaReference(key));
    } else {
      location = { type: 'external', url: source };
    }
    const width = ['image', 'video'].includes(kind) ? metadata.width : null;
    const height = ['image', 'video'].includes(kind) ? metadata.height : null;
    if (item.oversized.has('postmeta:_wp_attachment_metadata')) {
      warnings.add('media_metadata_skipped', label);
    }
    const row: WxrImportMediaRow = {
      external_id: externalId,
      kind,
      filename,
      mime_type: mimeType,
      location,
      size_bytes: metadata.sizeBytes,
      width,
      height,
      duration_ms: null,
      alt: kind === 'image'
        ? compactText(
            item.postmeta._wp_attachment_image_alt ?? '',
            MEDIA_ALT_MAX_CODE_POINTS,
          )
        : '',
    };
    const sourceIdentity = mediaLocationIdentity(location);
    const currentLocation = attachmentLocationByWpId.get(externalId);
    if (
      currentLocation
      && mediaLocationIdentity(currentLocation) !== sourceIdentity
    ) {
      throw new WxrCoreParseError('DUPLICATE_PUBLIC_ID');
    }
    attachmentLocationByWpId.set(externalId, location);
    const sourceExternalIds = mediaExternalIdsBySource.get(sourceIdentity)
      ?? new Set<number>();
    sourceExternalIds.add(externalId);
    mediaExternalIdsBySource.set(sourceIdentity, sourceExternalIds);
    const existing = mediaBySource.get(sourceIdentity);
    if (!existing) {
      mediaBySource.set(sourceIdentity, row);
      media.push(row);
    } else {
      if (externalId < existing.external_id) {
        existing.external_id = externalId;
      }
      if (existing.width === null && row.width !== null) existing.width = row.width;
      if (existing.height === null && row.height !== null) existing.height = row.height;
      if (existing.size_bytes === null && row.size_bytes !== null) {
        existing.size_bytes = row.size_bytes;
      }
      if (!existing.alt && row.alt) existing.alt = row.alt;
    }
  }

  const mediaByWpId = new Map<number, MediaLocation>();
  for (const [sourceIdentity, row] of mediaBySource) {
    if (row.kind !== 'image' || row.width === null || row.height === null) {
      continue;
    }
    for (const externalId of mediaExternalIdsBySource.get(sourceIdentity) ?? []) {
      mediaByWpId.set(externalId, row.location);
    }
  }

  const projectImportedText = (value: string) => mediaStrategy === 'r2'
    ? rewriteManagedMediaText({
        value,
        mediaFrom: mediaFrom!,
        exact: managedExactRewrites,
      })
    : value;

  type PendingPage = WxrImportPageRow & { rawParentId: number | null };
  type PendingComment = WxrImportCommentRow & {
    rawParentPublicId: number | null;
    label: string;
  };
  const posts: WxrImportPostRow[] = [];
  const pendingPages: PendingPage[] = [];
  const pendingComments: PendingComment[] = [];
  const seenPostIds = new Set<number>();
  const seenPageIds = new Set<number>();
  const seenCommentIds = new Set<number>();
  const reservedPostSlugs = new Set<string>();

  const collectComments = (
    item: RawItem,
    targetType: 'post' | 'page',
    targetPublicId: number,
  ) => {
    for (const raw of item.comments) {
      const idText = wpText(raw, 'comment_id');
      const label = `comment ${idText || wpText(raw, 'comment_author') || 'unknown'}`;
      const commentType = wpText(raw, 'comment_type');
      if (commentType && commentType !== 'comment') {
        warnings.add('unsupported_comment_types_skipped', label);
        continue;
      }
      const approval = wpText(raw, 'comment_approved');
      if (approval !== '0' && approval !== '1') {
        warnings.add('unsupported_comment_statuses_skipped', label);
        continue;
      }
      const publicId = normalizePublicId(idText);
      if (!publicId) {
        warnings.add('invalid_public_ids_skipped', label);
        continue;
      }
      const createdAtIso = parseGmtDate(wpText(raw, 'comment_date_gmt'));
      if (!createdAtIso) {
        warnings.add('invalid_dates_skipped', label);
        continue;
      }
      const sourceContentText = wpText(raw, 'comment_content');
      if (
        !sourceContentText
        || raw.oversized.has('comment_content')
        || sourceContentText.length > WXR_COMMENT_SOURCE_MAX_LENGTH
      ) {
        warnings.add('content_limits_skipped', label);
        continue;
      }
      let contentText = sourceContentText;
      if (contentText.length > COMMENT_CONTENT_MAX_LENGTH) {
        contentText = compactImportedCommentWhitespace(contentText);
        if (
          !contentText
          || contentText.length > COMMENT_CONTENT_MAX_LENGTH
        ) {
          warnings.add('content_limits_skipped', label);
          continue;
        }
        warnings.add('compacted_comment_whitespace', label);
      }
      if (seenCommentIds.has(publicId)) {
        throw new WxrCoreParseError('DUPLICATE_PUBLIC_ID');
      }
      seenCommentIds.add(publicId);

      const rawAuthorName = wpText(raw, 'comment_author');
      const authorName = compactText(
        rawAuthorName || 'Anonymous',
        COMMENT_AUTHOR_NAME_MAX_LENGTH,
      );
      if (
        raw.oversized.has('comment_author')
        || (rawAuthorName && authorName !== rawAuthorName)
      ) warnings.add('truncated_fields', label);

      const rawAuthorEmail = wpText(raw, 'comment_author_email');
      const authorEmail = !raw.oversized.has('comment_author_email')
        && commentAuthorEmailSchema.safeParse(rawAuthorEmail).success
        ? rawAuthorEmail
        : '';
      if (rawAuthorEmail && !authorEmail) {
        warnings.add('invalid_comment_emails_discarded', label);
      }

      const parentText = wpText(raw, 'comment_parent');
      const hasParent = parentText !== '' && parentText !== '0';
      const rawParentPublicId = hasParent ? normalizePublicId(parentText) : null;
      if (hasParent && rawParentPublicId === null) {
        warnings.add('invalid_comment_parents', label);
      }
      pendingComments.push({
        public_id: publicId,
        target_type: targetType,
        target_public_id: targetPublicId,
        parent_public_id: null,
        rawParentPublicId,
        author_name: authorName,
        author_email: authorEmail,
        content_text: contentText,
        status: approval === '1' ? 'approved' : 'pending',
        created_at_iso: createdAtIso,
        label,
      });
    }
  };

  for (const item of document.items) {
    const type = wpText(item, 'post_type');
    if (type !== 'post' && type !== 'page') {
      continue;
    }
    const wpIdText = wpText(item, 'post_id');
    const publicId = normalizePublicId(wpIdText);
    const rawLabel = compactText(item.title, POST_TITLE_MAX_LENGTH)
      || `${type} ${wpIdText || 'unknown'}`;
    if (!publicId) {
      warnings.add('invalid_public_ids_skipped', rawLabel);
      continue;
    }
    const seen = type === 'post' ? seenPostIds : seenPageIds;
    if (seen.has(publicId)) throw new WxrCoreParseError('DUPLICATE_PUBLIC_ID');
    seen.add(publicId);

    const rawStatus = wpText(item, 'status');
    if (rawStatus === 'trash' || rawStatus === 'auto-draft') {
      warnings.add('unsupported_items_skipped', rawLabel);
      continue;
    }
    const passwordProtected = Boolean(wpText(item, 'post_password'));
    let status: 'draft' | 'published' = rawStatus === 'publish'
      ? 'published'
      : 'draft';
    if (passwordProtected && status === 'published') {
      status = 'draft';
      warnings.add('password_protected_downgraded', rawLabel);
    } else if (!['publish', 'draft'].includes(rawStatus)) {
      warnings.add('unsupported_statuses_downgraded', rawLabel);
    }

    const modified = parseGmtDate(wpText(item, 'post_modified_gmt'));
    const authoredDate = parseGmtDate(wpText(item, 'post_date_gmt'));
    const created = authoredDate ?? (status === 'draft' ? modified : null);
    if (!created || !modified) {
      warnings.add('invalid_dates_skipped', rawLabel);
      continue;
    }
    const updated = Date.parse(modified) < Date.parse(created) ? created : modified;
    if (updated !== modified) warnings.add('truncated_fields', rawLabel);
    if (item.oversized.has('content')) {
      warnings.add('content_limits_skipped', rawLabel);
      continue;
    }
    const titleMaximum = type === 'post' ? POST_TITLE_MAX_LENGTH : PAGE_TITLE_MAX_LENGTH;
    const title = compactText(item.title, titleMaximum)
      || `Untitled ${type} ${publicId}`;
    if (title !== item.title.trim()) warnings.add('truncated_fields', rawLabel);
    const slugBase = normalizeSlug(
      wpText(item, 'post_name'),
      title || `${type}-${publicId}`,
    );
    const excerptMaximum = type === 'post'
      ? POST_EXCERPT_MAX_LENGTH
      : PAGE_EXCERPT_MAX_LENGTH;
    const computedExcerpt = computeImportedHtmlExcerpt({
      excerpt: item.excerpt,
      metaDescription: firstPostMetaValue(item, SEO_DESCRIPTION_META_KEYS),
      candidateMaximum: excerptMaximum,
    });
    const excerpt = compactText(computedExcerpt, excerptMaximum);
    if (
      item.oversized.has('excerpt')
      || excerpt !== computedExcerpt.trim()
    ) warnings.add('truncated_fields', rawLabel);
    const commentStatus = wpText(item, 'comment_status');
    const allowComments = commentStatus === 'open';
    if (!['open', 'closed'].includes(commentStatus)) {
      warnings.add('invalid_comment_statuses', rawLabel);
    }
    const thumbnailId = item.postmeta._thumbnail_id?.trim() ?? '';
    const thumbnailExternalId = normalizePublicId(thumbnailId);
    const featuredLocation = thumbnailExternalId !== null
      ? mediaByWpId.get(thumbnailExternalId) ?? null
      : null;
    if (thumbnailId && !featuredLocation) {
      warnings.add('unresolved_featured_images', rawLabel);
    }

    const projectedContent = projectImportedText(
      materializeWordPressClassicHtml(item.content),
    );
    const editorContent = classifyImportedContent(projectedContent, rawLabel);
    if (type === 'post') {
      const categorySlugs: string[] = [];
      const tagSlugs: string[] = [];
      for (const term of item.categories) {
        if (term.domain === 'category') {
          const slug = addTaxonomy(categories, term.nicename, term.text, '', true);
          if (slug && !categorySlugs.includes(slug)) categorySlugs.push(slug);
        } else if (term.domain === 'post_tag') {
          const slug = addTaxonomy(tags, term.nicename, term.text, '', true);
          if (slug && !tagSlugs.includes(slug)) tagSlugs.push(slug);
        }
      }
      if (
        categorySlugs.length > POST_RELATION_MAX_ITEMS
        || tagSlugs.length > POST_RELATION_MAX_ITEMS
      ) warnings.add('truncated_fields', rawLabel);
      const author = resolveAuthor(item.creator);
      posts.push({
        public_id: publicId,
        title,
        slug: reserveSlug({
          base: slugBase,
          publicId,
          scope: 'posts',
          reserved: reservedPostSlugs,
          warnings,
          label: rawLabel,
        }),
        content: editorContent.content,
        document_type: 'html',
        editor_mode: editorContent.editor_mode,
        editor_profile: editorContent.editor_profile,
        excerpt: projectImportedText(excerpt),
        status,
        author_id: author.id,
        category_slugs: categorySlugs.slice(0, POST_RELATION_MAX_ITEMS).sort(),
        tag_slugs: tagSlugs.slice(0, POST_RELATION_MAX_ITEMS),
        discoverability: 'default',
        allow_comments: allowComments,
        featured_image_location: featuredLocation,
        published_at_iso: status === 'published' ? created : null,
        created_at_iso: created,
        updated_at_iso: updated,
      });
      collectComments(item, 'post', publicId);
    } else {
      const parentIdText = wpText(item, 'post_parent');
      const hasParent = parentIdText !== '0' && parentIdText !== '';
      const rawParentId = hasParent ? normalizePublicId(parentIdText) : null;
      if (hasParent && rawParentId === null) {
        warnings.add('orphan_page_parents', title);
      }
      pendingPages.push({
        public_id: publicId,
        parent_public_id: null,
        rawParentId,
        title,
        slug: slugBase,
        content: editorContent.content.slice(0, PAGE_CONTENT_MAX_LENGTH),
        document_type: 'html',
        editor_mode: editorContent.editor_mode,
        editor_profile: editorContent.editor_profile,
        excerpt: projectImportedText(excerpt),
        status,
        discoverability: 'default',
        allow_comments: allowComments,
        featured_image_location: featuredLocation,
        created_at_iso: created,
        updated_at_iso: updated,
      });
      collectComments(item, 'page', publicId);
    }
  }

  const pagesById = new Map(pendingPages.map((page) => [page.public_id, page]));
  for (const page of pendingPages) {
    if (page.rawParentId === null) continue;
    if (!pagesById.has(page.rawParentId)) {
      warnings.add('orphan_page_parents', page.title);
      continue;
    }
    page.parent_public_id = page.rawParentId;
  }

  const visitState = new Map<number, 'visiting' | 'visited'>();
  const orderedPages: PendingPage[] = [];
  for (const start of [...pendingPages].sort((a, b) => a.public_id - b.public_id)) {
    if (visitState.get(start.public_id) === 'visited') continue;
    const chain: PendingPage[] = [];
    let current: PendingPage | undefined = start;
    while (current && visitState.get(current.public_id) !== 'visited') {
      if (visitState.get(current.public_id) === 'visiting') {
        throw new WxrCoreParseError('PAGE_CYCLE');
      }
      visitState.set(current.public_id, 'visiting');
      chain.push(current);
      current = current.parent_public_id === null
        ? undefined
        : pagesById.get(current.parent_public_id);
    }
    while (chain.length > 0) {
      const page = chain.pop()!;
      visitState.set(page.public_id, 'visited');
      orderedPages.push(page);
    }
  }
  const reservedPageSlugs = new Set<string>();
  const pages: WxrImportPageRow[] = orderedPages.map((page) => {
    const { rawParentId: _rawParentId, ...row } = page;
    return {
      ...row,
      slug: reserveSlug({
        base: page.slug,
        publicId: page.public_id,
        scope: page.parent_public_id === null
          ? 'root'
          : String(page.parent_public_id),
        reserved: reservedPageSlugs,
        warnings,
        label: page.title,
      }),
    };
  });

  const menus = buildImportedMenus({
    document,
    posts,
    pages,
    categoryByWpId,
    tagByWpId,
    sourceSiteUrl,
    warnings,
  });

  const commentsById = new Map(
    pendingComments.map((comment) => [comment.public_id, comment]),
  );
  for (const comment of pendingComments) {
    if (comment.rawParentPublicId === null) continue;
    const parent = commentsById.get(comment.rawParentPublicId);
    if (
      !parent
      || parent.target_type !== comment.target_type
      || parent.target_public_id !== comment.target_public_id
      || parent.public_id === comment.public_id
    ) {
      warnings.add('invalid_comment_parents', comment.label);
      comment.rawParentPublicId = null;
      continue;
    }
    comment.parent_public_id = parent.public_id;
  }

  const cycleChecked = new Set<number>();
  for (const start of [...pendingComments].sort(
    (left, right) => left.public_id - right.public_id,
  )) {
    if (cycleChecked.has(start.public_id)) continue;
    const chain: PendingComment[] = [];
    const chainIndex = new Map<number, number>();
    let current: PendingComment | undefined = start;
    while (current && !cycleChecked.has(current.public_id)) {
      const repeatedAt = chainIndex.get(current.public_id);
      if (repeatedAt !== undefined) {
        const cycle = chain.slice(repeatedAt);
        const cut = cycle.reduce((lowest, candidate) => (
          candidate.public_id < lowest.public_id ? candidate : lowest
        ));
        cut.parent_public_id = null;
        cut.rawParentPublicId = null;
        warnings.add('invalid_comment_parents', cut.label);
        break;
      }
      chainIndex.set(current.public_id, chain.length);
      chain.push(current);
      current = current.parent_public_id === null
        ? undefined
        : commentsById.get(current.parent_public_id);
    }
    for (const comment of chain) cycleChecked.add(comment.public_id);
  }

  const orderedComments: PendingComment[] = [];
  const emittedComments = new Set<number>();
  for (const start of [...pendingComments].sort(
    (left, right) => left.public_id - right.public_id,
  )) {
    if (emittedComments.has(start.public_id)) continue;
    const chain: PendingComment[] = [];
    let current: PendingComment | undefined = start;
    while (current && !emittedComments.has(current.public_id)) {
      chain.push(current);
      current = current.parent_public_id === null
        ? undefined
        : commentsById.get(current.parent_public_id);
    }
    while (chain.length > 0) {
      const comment = chain.pop()!;
      if (emittedComments.has(comment.public_id)) continue;
      emittedComments.add(comment.public_id);
      orderedComments.push(comment);
    }
  }
  const comments: WxrImportCommentRow[] = orderedComments.map((comment) => {
    const {
      rawParentPublicId: _rawParentPublicId,
      label: _label,
      ...row
    } = comment;
    return row;
  });

  const rows = {
    authors: [...authorByLogin.values()].sort((a, b) => (
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    )),
    categories: [...categories.values()].sort((a, b) => (
      a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
    )),
    tags: [...tags.values()].sort((a, b) => (
      a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
    )),
    media: media.sort((a, b) => a.external_id - b.external_id),
    posts: posts.sort((a, b) => a.public_id - b.public_id),
    pages,
    menus,
    comments,
  };
  const rowSchemas = {
    authors: wxrImportAuthorRowSchema,
    categories: wxrImportCategoryRowSchema,
    tags: wxrImportTagRowSchema,
    media: wxrImportMediaRowSchema,
    posts: wxrImportPostRowSchema,
    pages: wxrImportPageRowSchema,
    menus: wxrImportMenuRowSchema,
    comments: wxrImportCommentRowSchema,
  } as const;
  for (const phase of Object.keys(rows) as Array<keyof typeof rows>) {
    for (const row of rows[phase]) {
      if (!rowSchemas[phase].safeParse(row).success) {
        throw new WxrCoreParseError('INVALID_WXR');
      }
    }
  }
  if (Object.values(rows).every((values) => values.length === 0)) {
    throw new WxrCoreParseError('NO_IMPORTABLE_CONTENT');
  }
  return {
    source: {
      site_title: document.channel.title.trim(),
      site_url: sourceSiteUrl,
      site_settings: siteSettings,
      permalinks,
      media_strategy: mediaStrategy,
      media_from: mediaFrom,
    },
    rows,
    editor_compatibility: {
      visual: editorCompatibility.visual,
      source: editorCompatibility.source,
      source_fallbacks: [...editorCompatibility.fallbacks]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([reason, value]) => ({ reason, ...value })),
    },
    warnings: warnings.list(),
  };
}

export async function parseWxrCoreImportFile(
  file: File,
  options?: WxrCoreParserOptions,
): Promise<WxrCoreImportPlan> {
  return createPlan(await parseWxrFile(file), options);
}
