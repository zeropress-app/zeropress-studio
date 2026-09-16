import {
  generateHTML,
  generateJSON,
  type JSONContent,
} from '@tiptap/core';
import { parseFragment, serialize } from 'parse5';
import {
  CONTENT_EDITOR_VISUAL_MAX_CODE_UNITS,
  CONTENT_EDITOR_VISUAL_MAX_NODES,
} from '../../../contracts/content-editor';
import {
  createTiptapVisualExtensions,
  isAllowedContentUrl,
  normalizeContentTextAlignment,
  normalizeContentTextColor,
  parseContentStyleDeclarations,
  TIPTAP_INERT_RESOURCE_MARKER_PREFIX,
  TIPTAP_INERT_RESOURCE_URL,
} from './tiptap-profile';
import { formatTiptapVisualHtml } from './tiptap-html-serialization';

const BUILD_CORE_ALLOWED_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'br', 'hr',
  'strong', 'em', 'u', 's', 'sup', 'sub', 'code', 'pre',
  'a', 'img',
  'ul', 'ol', 'li',
  'blockquote', 'aside',
  'figure', 'figcaption', 'picture', 'source',
  'video', 'audio', 'track',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'div', 'span', 'nav',
  'iframe', 'input',
]);
const BUILD_CORE_GLOBAL_ATTRIBUTES = new Set(['class', 'id']);
const BUILD_CORE_ALLOWED_ATTRIBUTES = new Map([
  ['a', new Set(['href', 'title', 'class', 'id', 'target', 'rel'])],
  ['aside', new Set(['role', 'class', 'id'])],
  ['img', new Set([
    'src', 'srcset', 'sizes', 'alt', 'title', 'class', 'id',
    'width', 'height', 'loading', 'decoding',
  ])],
  ['iframe', new Set([
    'src', 'width', 'height', 'frameborder', 'allowfullscreen', 'class', 'title',
  ])],
  ['input', new Set(['type', 'checked', 'disabled', 'class', 'id', 'aria-label'])],
  ['source', new Set([
    'src', 'srcset', 'sizes', 'type', 'media', 'width', 'height', 'class', 'id',
  ])],
  ['th', new Set(['rowspan', 'colspan', 'align', 'class', 'id'])],
  ['td', new Set(['rowspan', 'colspan', 'align', 'class', 'id'])],
  ['video', new Set([
    'src', 'controls', 'controlslist', 'autoplay', 'loop', 'muted',
    'playsinline', 'poster', 'preload', 'width', 'height', 'class', 'id', 'title',
  ])],
  ['audio', new Set([
    'src', 'controls', 'controlslist', 'autoplay', 'loop', 'muted', 'preload',
    'class', 'id', 'title',
  ])],
  ['track', new Set([
    'src', 'kind', 'srclang', 'label', 'default', 'class', 'id',
  ])],
]);
const URL_ATTRIBUTES = new Set(['href', 'src', 'srcset', 'poster']);
const CANONICAL_TAGS = new Map([
  ['b', 'strong'],
  ['i', 'em'],
  ['strike', 's'],
]);
const TEXT_BOUNDARY_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

export const TIPTAP_BLOCKING_REASONS = [
  'source_too_large',
  'canonical_too_large',
  'node_limit_exceeded',
  'visible_text_changed',
  'contract_data_lost',
  'conversion_error',
] as const;
export type TiptapBlockingReason = typeof TIPTAP_BLOCKING_REASONS[number];

export const TIPTAP_REVIEW_REASONS = [
  'unsupported_elements_removed',
  'unsupported_attributes_removed',
] as const;
export type TiptapReviewReason = typeof TIPTAP_REVIEW_REASONS[number];
export type TiptapFallbackReason = TiptapBlockingReason | TiptapReviewReason;

export type TiptapCompatibilityResult =
  | {
      classification: 'safe';
      compatible: true;
      canonicalHtml: string;
      nodeCount: number;
      normalized: boolean;
      reasons: [];
    }
  | {
      classification: 'review_required';
      compatible: false;
      canonicalHtml: string;
      nodeCount: number;
      normalized: true;
      reasons: TiptapReviewReason[];
    }
  | {
      classification: 'blocked';
      compatible: false;
      canonicalHtml: null;
      nodeCount: number | null;
      normalized: false;
      reasons: TiptapBlockingReason[];
    };

type HtmlNode = {
  nodeName?: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
  content?: HtmlNode;
};

type HtmlAnalysis = {
  text: string;
  tags: Map<string, number>;
  attributeValues: Map<string, number>;
  urls: Map<string, number>;
  unsupportedElements: Map<string, number>;
  unsupportedAttributeValues: Map<string, number>;
};

type ResourceAttribute = {
  name: string;
  value: string;
};

type ResourceRestoration = {
  marker: string;
  originalId: ResourceAttribute | null;
  attributes: ResourceAttribute[];
};

const RESOURCE_ATTRIBUTES = new Map<string, ReadonlySet<string>>([
  ['img', new Set(['src', 'srcset'])],
  ['iframe', new Set(['src'])],
  ['video', new Set(['src', 'poster'])],
  ['audio', new Set(['src'])],
  ['source', new Set(['src', 'srcset'])],
  ['track', new Set(['src'])],
]);
const POTENTIALLY_LOADING_ATTRIBUTES = new Set([
  'src',
  'srcset',
  'poster',
  'data',
  'background',
  'srcdoc',
  'style',
  'xlink:href',
  'imagesrcset',
  'imagesizes',
]);
const TEXT_ALIGNMENT_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

type ContentStyleAnalysis = {
  supported: Map<string, string>;
  unsupported: string[];
};

function analyzeContentStyle(tag: string, value: string): ContentStyleAnalysis {
  const parsed = parseContentStyleDeclarations(value);
  const nonEmptySegments = value.split(';')
    .map((segment) => segment.trim())
    .filter(Boolean);
  const effective = new Map<string, string>();
  for (const declaration of parsed) {
    effective.set(declaration.property, declaration.value);
  }
  const supported = new Map<string, string>();
  const unsupported: string[] = [];
  if (parsed.length < nonEmptySegments.length) {
    unsupported.push(`malformed:${value.trim()}`);
  }
  for (const [property, declarationValue] of effective) {
    if (property === 'text-align' && TEXT_ALIGNMENT_TAGS.has(tag)) {
      const alignment = normalizeContentTextAlignment(declarationValue);
      if (alignment) {
        supported.set(property, alignment);
        continue;
      }
    }
    if (property === 'color' && tag === 'span') {
      const color = normalizeContentTextColor(declarationValue);
      if (color) {
        supported.set(property, color);
        continue;
      }
    }
    unsupported.push(`${property}:${declarationValue}`);
  }
  return { supported, unsupported };
}

function safeStyleAttribute(tag: string, value: string): ResourceAttribute | null {
  const analysis = analyzeContentStyle(tag, value);
  if (analysis.supported.size === 0) return null;
  return {
    name: 'style',
    value: [...analysis.supported]
      .map(([property, declarationValue]) => `${property}: ${declarationValue}`)
      .join('; '),
  };
}

function increment(counter: Map<string, number>, key: string) {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

function normalizeAttributeValue(name: string, value: string): string {
  if (name === 'class' || name === 'controlslist') {
    return [...new Set(value.trim().split(/\s+/u).filter(Boolean))]
      .sort()
      .join(' ');
  }
  return value;
}

function supportedAttributeKeys(
  tag: string,
  name: string,
  value: string,
): string[] {
  if (name === 'rel') {
    return [...new Set(value.trim().toLowerCase().split(/\s+/u).filter(Boolean))]
      .sort()
      .map((token) => `${tag}@rel~=${token}`);
  }
  return [`${tag}@${name}=${normalizeAttributeValue(name, value)}`];
}

function isAllowedAttribute(tag: string, attribute: string): boolean {
  return BUILD_CORE_GLOBAL_ATTRIBUTES.has(attribute)
    || BUILD_CORE_ALLOWED_ATTRIBUTES.get(tag)?.has(attribute) === true;
}

function visibleText(node: HtmlNode, hidden = false): string {
  const childrenHidden = hidden
    || node.tagName === 'script'
    || node.tagName === 'style'
    || node.tagName === 'template';
  if (childrenHidden) return '';
  if (node.nodeName === '#text') return node.value ?? '';
  let value = '';
  for (const child of node.childNodes ?? []) value += visibleText(child);
  if (node.content) value += visibleText(node.content);
  if (node.tagName === 'br') return '\n';
  return node.tagName && TEXT_BOUNDARY_TAGS.has(node.tagName)
    ? `\n${value}\n`
    : value;
}

function walk(node: HtmlNode, visit: (node: HtmlNode) => void) {
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
  if (node.content) walk(node.content, visit);
}

function isRestorableResourceAttribute(
  tag: string,
  attribute: ResourceAttribute,
): boolean {
  if (RESOURCE_ATTRIBUTES.get(tag)?.has(attribute.name) !== true) return false;
  if (attribute.name === 'src' || attribute.name === 'poster') {
    return isAllowedContentUrl(attribute.value, 'media');
  }
  return true;
}

function shouldStripBeforeBrowserParse(
  tag: string,
  attribute: ResourceAttribute,
): boolean {
  return POTENTIALLY_LOADING_ATTRIBUTES.has(attribute.name)
    || (attribute.name === 'href' && tag !== 'a');
}

/**
 * Browser DOMParser can fetch resources referenced by otherwise detached HTML.
 * Tiptap's browser HTML helper uses DOMParser internally, so WXR preflight must
 * remove every fetch-capable attribute before handing it the document. The
 * accepted resource attributes are restored only after Tiptap has serialized
 * into a string, using parse5 on both sides so restoration itself stays inert.
 */
export function prepareNetworkInertTiptapHtml(html: string): {
  html: string;
  restorations: ResourceRestoration[];
} {
  const fragment = parseFragment(html);
  const root = fragment as unknown as HtmlNode;
  const occupiedIds = new Set<string>();
  walk(root, (node) => {
    const id = node.attrs?.find((attribute) => attribute.name === 'id');
    if (id) occupiedIds.add(id.value);
  });

  const restorations: ResourceRestoration[] = [];
  let markerIndex = 0;
  walk(root, (node) => {
    const tag = node.tagName;
    if (!tag) return;
    if (tag === 'style') {
      node.childNodes = [];
      node.content = undefined;
    }
    const originalAttributes = node.attrs ?? [];
    const resourceAttributes = originalAttributes.filter((attribute) => (
      isRestorableResourceAttribute(tag, attribute)
    ));
    let attributes = originalAttributes.flatMap((attribute) => {
      if (attribute.name === 'style') {
        const safeStyle = safeStyleAttribute(tag, attribute.value);
        return safeStyle ? [safeStyle] : [];
      }
      return shouldStripBeforeBrowserParse(tag, attribute) ? [] : [attribute];
    });
    if (tag === 'meta') {
      attributes = attributes.filter((attribute) => (
        attribute.name !== 'http-equiv' && attribute.name !== 'content'
      ));
    }
    if (resourceAttributes.length > 0) {
      let marker = '';
      do {
        marker = `${TIPTAP_INERT_RESOURCE_MARKER_PREFIX}${markerIndex}__`;
        markerIndex += 1;
      } while (occupiedIds.has(marker));
      occupiedIds.add(marker);
      const originalId = originalAttributes.find((attribute) => (
        attribute.name === 'id'
      )) ?? null;
      attributes = attributes.filter((attribute) => attribute.name !== 'id');
      attributes.push({ name: 'id', value: marker });
      for (const attribute of resourceAttributes) {
        attributes.push({
          name: attribute.name,
          value: TIPTAP_INERT_RESOURCE_URL,
        });
      }
      restorations.push({ marker, originalId, attributes: resourceAttributes });
    }
    node.attrs = attributes;
  });

  return {
    html: serialize(fragment),
    restorations,
  };
}

function restoreNetworkInertResources(
  html: string,
  restorations: readonly ResourceRestoration[],
): string {
  if (restorations.length === 0) return html;
  const fragment = parseFragment(html);
  const root = fragment as unknown as HtmlNode;
  const remaining = new Map(
    restorations.map((restoration) => [restoration.marker, restoration]),
  );
  walk(root, (node) => {
    const marker = node.attrs?.find((attribute) => attribute.name === 'id')?.value;
    if (!marker) return;
    const restoration = remaining.get(marker);
    if (!restoration) return;
    const restored = new Map(restoration.attributes.map((attribute) => (
      [attribute.name, attribute]
    )));
    const attributes: ResourceAttribute[] = [];
    for (const attribute of node.attrs ?? []) {
      if (attribute.name === 'id') {
        if (restoration.originalId) attributes.push(restoration.originalId);
        continue;
      }
      const replacement = restored.get(attribute.name);
      if (replacement) {
        attributes.push(replacement);
        restored.delete(attribute.name);
      } else {
        attributes.push(attribute);
      }
    }
    if (restored.size > 0) {
      throw new TypeError('Tiptap removed a protected resource attribute.');
    }
    node.attrs = attributes;
    remaining.delete(marker);
  });
  if (remaining.size > 0) {
    throw new TypeError('Tiptap removed a protected resource element.');
  }
  return serialize(fragment);
}

function analyzeHtml(html: string): HtmlAnalysis {
  const fragment = parseFragment(html) as unknown as HtmlNode;
  const analysis: HtmlAnalysis = {
    text: visibleText(fragment),
    tags: new Map(),
    attributeValues: new Map(),
    urls: new Map(),
    unsupportedElements: new Map(),
    unsupportedAttributeValues: new Map(),
  };
  walk(fragment, (node) => {
    if (!node.tagName) {
      if (node.nodeName === '#comment') {
        increment(analysis.unsupportedElements, '#comment');
      }
      return;
    }
    const tag = CANONICAL_TAGS.get(node.tagName) ?? node.tagName;
    if (!BUILD_CORE_ALLOWED_TAGS.has(tag)) {
      increment(analysis.unsupportedElements, tag);
      return;
    }
    increment(analysis.tags, tag);
    for (const attribute of node.attrs ?? []) {
      if (attribute.name === 'style') {
        const style = analyzeContentStyle(tag, attribute.value);
        for (const [property, declarationValue] of style.supported) {
          increment(
            analysis.attributeValues,
            `${tag}@style:${property}=${declarationValue}`,
          );
        }
        for (const unsupported of style.unsupported) {
          increment(
            analysis.unsupportedAttributeValues,
            `${tag}@style:${unsupported}`,
          );
        }
        continue;
      }
      if (!isAllowedAttribute(tag, attribute.name)) {
        increment(
          analysis.unsupportedAttributeValues,
          `${tag}@${attribute.name}=${attribute.value}`,
        );
        continue;
      }
      for (const key of supportedAttributeKeys(
        tag,
        attribute.name,
        attribute.value,
      )) {
        increment(analysis.attributeValues, key);
        if (URL_ATTRIBUTES.has(attribute.name)) increment(analysis.urls, key);
      }
    }
  });
  return analysis;
}

function counterHasMissing(
  source: Map<string, number>,
  output: Map<string, number>,
): boolean {
  for (const [key, count] of source) {
    if ((output.get(key) ?? 0) < count) return true;
  }
  return false;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

export function countProseMirrorNodes(node: JSONContent): number {
  let count = 1;
  for (const child of node.content ?? []) count += countProseMirrorNodes(child);
  return count;
}

function hasMeaningfulAttributes(node: JSONContent): boolean {
  return Object.values(node.attrs ?? {}).some((value) => (
    value !== null && value !== undefined && value !== ''
  ));
}

function convertTiptapHtml(html: string): {
  json: JSONContent;
  canonicalHtml: string;
} {
  const prepared = prepareNetworkInertTiptapHtml(html);
  const extensions = createTiptapVisualExtensions();
  const json = generateJSON(prepared.html, extensions) as JSONContent;
  const hasContent = (json.content ?? []).some((node: JSONContent) => (
    node.type !== 'paragraph'
    || (node.content?.length ?? 0) > 0
    || hasMeaningfulAttributes(node)
  ));
  const generated = hasContent ? generateHTML(json, extensions) : '';
  return {
    json,
    canonicalHtml: formatTiptapVisualHtml(restoreNetworkInertResources(
      generated,
      prepared.restorations,
    )),
  };
}

export function canonicalizeTiptapHtml(html: string): string {
  return convertTiptapHtml(html).canonicalHtml;
}

export function classifyTiptapHtml(html: string): TiptapCompatibilityResult {
  if (html.length > CONTENT_EDITOR_VISUAL_MAX_CODE_UNITS) {
    return {
      classification: 'blocked',
      compatible: false,
      canonicalHtml: null,
      nodeCount: null,
      normalized: false,
      reasons: ['source_too_large'],
    };
  }
  try {
    const { json, canonicalHtml } = convertTiptapHtml(html);
    const nodeCount = countProseMirrorNodes(json);
    const reasons: TiptapBlockingReason[] = [];
    if (canonicalHtml.length > CONTENT_EDITOR_VISUAL_MAX_CODE_UNITS) {
      reasons.push('canonical_too_large');
    }
    if (nodeCount > CONTENT_EDITOR_VISUAL_MAX_NODES) {
      reasons.push('node_limit_exceeded');
    }
    const source = analyzeHtml(html);
    const canonical = analyzeHtml(canonicalHtml);
    if (collapseWhitespace(source.text) !== collapseWhitespace(canonical.text)) {
      reasons.push('visible_text_changed');
    }
    const canonicalEmptyParagraphs = canonicalHtml === ''
      && collapseWhitespace(source.text) === ''
      && source.attributeValues.size === 0
      && source.urls.size === 0
      && [...source.tags.keys()].every((tag) => tag === 'p');
    if (
      !canonicalEmptyParagraphs
      && (
        counterHasMissing(source.tags, canonical.tags)
        || counterHasMissing(source.attributeValues, canonical.attributeValues)
        || counterHasMissing(source.urls, canonical.urls)
      )
    ) reasons.push('contract_data_lost');
    if (reasons.length > 0) {
      return {
        classification: 'blocked',
        compatible: false,
        canonicalHtml: null,
        nodeCount,
        normalized: false,
        reasons: [...new Set(reasons)],
      };
    }
    const reviewReasons: TiptapReviewReason[] = [];
    if (counterHasMissing(
      source.unsupportedElements,
      canonical.unsupportedElements,
    )) {
      reviewReasons.push('unsupported_elements_removed');
    }
    if (counterHasMissing(
      source.unsupportedAttributeValues,
      canonical.unsupportedAttributeValues,
    )) {
      reviewReasons.push('unsupported_attributes_removed');
    }
    if (reviewReasons.length > 0) {
      return {
        classification: 'review_required',
        compatible: false,
        canonicalHtml,
        nodeCount,
        normalized: true,
        reasons: reviewReasons,
      };
    }
    return {
      classification: 'safe',
      compatible: true,
      canonicalHtml,
      nodeCount,
      normalized: html !== canonicalHtml,
      reasons: [],
    };
  } catch {
    return {
      classification: 'blocked',
      compatible: false,
      canonicalHtml: null,
      nodeCount: null,
      normalized: false,
      reasons: ['conversion_error'],
    };
  }
}
