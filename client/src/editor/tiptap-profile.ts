import {
  Extension,
  Mark,
  Node,
  mergeAttributes,
  type Extensions,
} from '@tiptap/core';
import type { DOMOutputSpec } from '@tiptap/pm/model';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import { Color, TextStyle } from '@tiptap/extension-text-style';
import {
  Table,
  TableCell,
  TableHeader,
  TableRow,
} from '@tiptap/extension-table';
import StarterKit from '@tiptap/starter-kit';

const GLOBAL_ATTRIBUTE_TYPES = [
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
  'horizontalRule',
  'hardBreak',
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'link',
  'image',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'genericDiv',
  'genericSpan',
  'textStyle',
  'richPre',
  'figure',
  'figcaption',
  'iframe',
  'video',
  'audio',
  'mediaSource',
  'mediaTrack',
] as const;

export const TIPTAP_TEXT_ALIGNMENTS = [
  'left',
  'center',
  'right',
  'justify',
] as const;
export type TiptapTextAlignment = typeof TIPTAP_TEXT_ALIGNMENTS[number];

export const TIPTAP_IMAGE_ALIGNMENTS = [
  'none',
  'left',
  'center',
  'right',
] as const;
export type TiptapImageAlignment = typeof TIPTAP_IMAGE_ALIGNMENTS[number];

const TIPTAP_TEXT_ALIGNMENT_SET = new Set<string>(TIPTAP_TEXT_ALIGNMENTS);
const TIPTAP_IMAGE_ALIGNMENT_SET = new Set<string>(TIPTAP_IMAGE_ALIGNMENTS);
const IMAGE_ALIGNMENT_CLASS = {
  none: 'alignnone',
  left: 'alignleft',
  center: 'aligncenter',
  right: 'alignright',
} satisfies Record<TiptapImageAlignment, string>;
const IMAGE_ALIGNMENT_BY_CLASS = new Map<string, TiptapImageAlignment>(
  Object.entries(IMAGE_ALIGNMENT_CLASS).map(([alignment, className]) => [
    className,
    alignment as TiptapImageAlignment,
  ]),
);
const CONTENT_COLOR_HEX_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;
const CONTENT_COLOR_NAME_PATTERN = /^[a-z]{1,32}$/iu;
const CONTENT_COLOR_FUNCTION_PATTERN = /^(?:rgb|rgba|hsl|hsla)\((?:[-+.\d%,/\s]|deg|rad|grad|turn)+\)$/iu;

export type ContentStyleDeclaration = {
  property: string;
  value: string;
};

export function parseContentStyleDeclarations(
  value: unknown,
): ContentStyleDeclaration[] {
  if (typeof value !== 'string') return [];
  const declarations: ContentStyleDeclaration[] = [];
  for (const segment of value.split(';')) {
    const separator = segment.indexOf(':');
    if (separator <= 0) continue;
    const property = segment.slice(0, separator).trim().toLowerCase();
    const declarationValue = segment.slice(separator + 1).trim();
    if (property === '' || declarationValue === '') continue;
    declarations.push({ property, value: declarationValue });
  }
  return declarations;
}

export function normalizeContentTextAlignment(
  value: unknown,
): TiptapTextAlignment | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return TIPTAP_TEXT_ALIGNMENT_SET.has(normalized)
    ? normalized as TiptapTextAlignment
    : null;
}

export function normalizeContentImageAlignment(
  value: unknown,
): TiptapImageAlignment | null {
  return typeof value === 'string' && TIPTAP_IMAGE_ALIGNMENT_SET.has(value)
    ? value as TiptapImageAlignment
    : null;
}

function imageAlignmentFromClass(value: unknown): TiptapImageAlignment | null {
  if (typeof value !== 'string') return null;
  const alignments = value.trim().split(/\s+/u).flatMap((className) => {
    const alignment = IMAGE_ALIGNMENT_BY_CLASS.get(className);
    return alignment ? [alignment] : [];
  });
  return alignments.length === 1 ? alignments[0] : null;
}

function imageClassWithAlignment(
  value: unknown,
  alignmentValue: unknown,
): string | null {
  const alignment = normalizeContentImageAlignment(alignmentValue);
  const replacement = alignment ? IMAGE_ALIGNMENT_CLASS[alignment] : null;
  const classes = typeof value === 'string'
    ? value.trim().split(/\s+/u).filter(Boolean)
    : [];
  const result: string[] = [];
  let replaced = false;
  for (const className of classes) {
    if (!IMAGE_ALIGNMENT_BY_CLASS.has(className)) {
      result.push(className);
      continue;
    }
    if (!replaced && replacement) {
      result.push(replacement);
      replaced = true;
    }
  }
  if (!replaced && replacement) result.push(replacement);
  return result.length > 0 ? result.join(' ') : null;
}

export function normalizeContentTextColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let normalized = value.trim().toLowerCase();
  if (
    normalized === ''
    || normalized.length > 128
    || /[\\'";{}!\p{Cc}]/u.test(normalized)
    || (
      !CONTENT_COLOR_HEX_PATTERN.test(normalized)
      && !CONTENT_COLOR_NAME_PATTERN.test(normalized)
      && !CONTENT_COLOR_FUNCTION_PATTERN.test(normalized)
    )
  ) return null;
  if (typeof document !== 'undefined') {
    const probe = document.createElement('span');
    probe.style.color = normalized;
    if (probe.style.color === '') return null;
    normalized = probe.style.color.toLowerCase();
  }
  return normalized
    .replace(/\s+/gu, ' ')
    .replace(/\s*([(),/])\s*/gu, '$1');
}

function lastStyleDeclaration(
  element: HTMLElement,
  property: string,
): string | null {
  let value: string | null = null;
  for (const declaration of parseContentStyleDeclarations(
    element.getAttribute('style'),
  )) {
    if (declaration.property === property) value = declaration.value;
  }
  return value;
}

const SAFE_REL_TOKENS = new Set([
  'noopener',
  'noreferrer',
  'nofollow',
  'ugc',
  'sponsored',
  'external',
]);

/**
 * Compatibility scans replace fetch-capable resource attributes before a
 * browser DOM parser sees authored HTML. The marker lets the shared Tiptap
 * profile retain the attribute's schema position without accepting arbitrary
 * data URLs as authored media.
 */
export const TIPTAP_INERT_RESOURCE_MARKER_PREFIX = '__zeropress_inert_resource_';
export const TIPTAP_INERT_RESOURCE_URL = 'data:,zeropress-inert-resource';

function hasUnsafeUrlText(value: string): boolean {
  return value === ''
    || /[\s\\\p{Cc}]/u.test(value)
    || /%(?![0-9A-Fa-f]{2})/u.test(value)
    || value.startsWith('//');
}

function isRootRelativeUrl(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//');
}

export function isAllowedContentUrl(
  value: unknown,
  kind: 'link' | 'media',
): value is string {
  if (typeof value !== 'string' || hasUnsafeUrlText(value)) return false;
  if (isRootRelativeUrl(value)) return true;
  try {
    const parsed = new URL(value);
    if (parsed.username !== '' || parsed.password !== '') return false;
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.hostname !== '';
    }
    return kind === 'link'
      && (parsed.protocol === 'mailto:' || parsed.protocol === 'tel:');
  } catch {
    return false;
  }
}

export function normalizeLinkTarget(value: unknown): '_blank' | null {
  return typeof value === 'string' && value.trim().toLowerCase() === '_blank'
    ? '_blank'
    : null;
}

export function normalizeLinkRel(
  value: unknown,
  target: unknown,
): string | null {
  const tokens = typeof value === 'string'
    ? value.toLowerCase().split(/\s+/u).filter((token, index, all) => (
        SAFE_REL_TOKENS.has(token) && all.indexOf(token) === index
      ))
    : [];
  if (normalizeLinkTarget(target) === '_blank') {
    for (const required of ['noopener', 'noreferrer']) {
      if (!tokens.includes(required)) tokens.push(required);
    }
  }
  return tokens.length > 0 ? tokens.join(' ') : null;
}

function stringAttribute(name: string) {
  return {
    default: null,
    parseHTML: (element: HTMLElement) => element.getAttribute(name),
  };
}

function safeUrlAttribute(name: string, kind: 'link' | 'media') {
  return {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const value = element.getAttribute(name);
      if (
        kind === 'media'
        && value === TIPTAP_INERT_RESOURCE_URL
        && element.id.startsWith(TIPTAP_INERT_RESOURCE_MARKER_PREFIX)
      ) return value;
      return isAllowedContentUrl(value, kind) ? value : null;
    },
  };
}

function booleanAttribute(name: string) {
  return {
    default: null,
    parseHTML: (element: HTMLElement) => (
      element.hasAttribute(name) ? true : null
    ),
    renderHTML: (values: Record<string, unknown>) => (
      values[name] === true ? { [name]: '' } : {}
    ),
  };
}

function attributes(
  stringNames: string[],
  booleanNames: string[] = [],
  mediaUrlNames: string[] = [],
) {
  return Object.fromEntries([
    ...stringNames.map((name) => [name, stringAttribute(name)]),
    ...booleanNames.map((name) => [name, booleanAttribute(name)]),
    ...mediaUrlNames.map((name) => [name, safeUrlAttribute(name, 'media')]),
  ]);
}

function compactAttributes(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => (
    value !== null && value !== undefined && value !== ''
  )));
}

function getSoleImageParentLink(element: HTMLElement): HTMLElement | null {
  const parent = element.parentElement;
  if (parent?.tagName.toLowerCase() !== 'a') return null;
  const images = parent.querySelectorAll('img');
  if (images.length !== 1 || images[0] !== element) return null;
  const hasOtherContent = [...parent.childNodes].some((child) => (
    child !== element
    && !(child.nodeName === '#text'
      && String(child.textContent ?? '').trim() === '')
  ));
  return hasOtherContent ? null : parent;
}

function linkedImageAttribute(name: string, kind: 'link' | 'plain') {
  return {
    default: null,
    rendered: false,
    parseHTML: (element: HTMLElement) => {
      const value = getSoleImageParentLink(element)?.getAttribute(name);
      if (kind === 'link') {
        return isAllowedContentUrl(value, 'link') ? value : null;
      }
      return value;
    },
  };
}

function imageAlignmentAttribute() {
  return {
    default: null,
    rendered: false,
    parseHTML: (element: HTMLElement) => imageAlignmentFromClass(
      element.getAttribute('class'),
    ),
  };
}

function tableAlignmentAttribute() {
  return {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const value = String(element.getAttribute('align') ?? '')
        .trim()
        .toLowerCase();
      return ['left', 'center', 'right'].includes(value) ? value : null;
    },
    renderHTML: ({ align }: { align?: unknown }) => (
      typeof align === 'string' && align !== '' ? { align } : {}
    ),
  };
}

const ContractAttributes = Extension.create({
  name: 'contractAttributes',
  addGlobalAttributes() {
    return [{
      types: [...GLOBAL_ATTRIBUTE_TYPES],
      attributes: {
        class: stringAttribute('class'),
        id: stringAttribute('id'),
      },
    }];
  },
});

const ContractLink = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      href: safeUrlAttribute('href', 'link'),
      target: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizeLinkTarget(
          element.getAttribute('target'),
        ),
      },
      rel: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizeLinkRel(
          element.getAttribute('rel'),
          element.getAttribute('target'),
        ),
      },
      title: stringAttribute('title'),
    };
  },
}).configure({
  openOnClick: false,
  enableClickSelection: true,
  protocols: ['http', 'https', 'mailto', 'tel'],
  isAllowedUri: (url) => isAllowedContentUrl(url, 'link'),
});

const ContractImage = Image.extend({
  name: 'image',
  addAttributes() {
    return {
      ...this.parent?.(),
      src: safeUrlAttribute('src', 'media'),
      srcset: stringAttribute('srcset'),
      sizes: stringAttribute('sizes'),
      loading: stringAttribute('loading'),
      decoding: stringAttribute('decoding'),
      alignment: imageAlignmentAttribute(),
      linkHref: linkedImageAttribute('href', 'link'),
      linkTarget: linkedImageAttribute('target', 'plain'),
      linkRel: linkedImageAttribute('rel', 'plain'),
      linkTitle: linkedImageAttribute('title', 'plain'),
    };
  },
  renderHTML({ node, HTMLAttributes }) {
    const imageAttributes = { ...HTMLAttributes };
    const className = imageClassWithAlignment(
      HTMLAttributes.class,
      node.attrs.alignment,
    );
    if (className) imageAttributes.class = className;
    else delete imageAttributes.class;
    const image: DOMOutputSpec = [
      'img',
      mergeAttributes(this.options.HTMLAttributes, imageAttributes),
    ];
    if (!node.attrs.linkHref) return image;
    const target = normalizeLinkTarget(node.attrs.linkTarget);
    return [
      'a',
      compactAttributes({
        href: node.attrs.linkHref,
        target,
        rel: normalizeLinkRel(node.attrs.linkRel, target),
        title: node.attrs.linkTitle,
      }),
      image,
    ] as DOMOutputSpec;
  },
});

const ContractTableCell = TableCell.extend({
  name: 'tableCell',
  addAttributes() {
    return { ...this.parent?.(), align: tableAlignmentAttribute() };
  },
});

const ContractTableHeader = TableHeader.extend({
  name: 'tableHeader',
  addAttributes() {
    return { ...this.parent?.(), align: tableAlignmentAttribute() };
  },
});

const GenericDiv = Node.create({
  name: 'genericDiv',
  group: 'block',
  content: 'block*',
  defining: true,
  parseHTML: () => [{ tag: 'div' }],
  renderHTML: ({ HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes),
    0,
  ],
});

const GenericSpan = Mark.create({
  name: 'genericSpan',
  inclusive: true,
  parseHTML: () => [{
    tag: 'span',
    getAttrs: (element) => (
      (element as HTMLElement).hasAttribute('style') ? false : null
    ),
  }],
  renderHTML: ({ HTMLAttributes }) => [
    'span',
    mergeAttributes(HTMLAttributes),
    0,
  ],
});

const ContractColor = Color.extend({
  addGlobalAttributes() {
    return [{
      types: this.options.types,
      attributes: {
        color: {
          default: null,
          parseHTML: (element: HTMLElement) => normalizeContentTextColor(
            lastStyleDeclaration(element, 'color'),
          ),
          renderHTML: (attributes: Record<string, unknown>) => {
            const color = normalizeContentTextColor(attributes.color);
            return color ? { style: `color: ${color}` } : {};
          },
        },
      },
    }];
  },
}).configure({ types: ['textStyle'] });

function hasRichPreContent(element: HTMLElement): boolean {
  return element.querySelector(
    'a, strong, b, em, i, u, s, strike, span, sup, sub',
  ) !== null;
}

const RichPre = Node.create({
  name: 'richPre',
  priority: 1_000,
  group: 'block',
  content: 'inline*',
  whitespace: 'pre',
  defining: true,
  parseHTML: () => [{
    tag: 'pre',
    getAttrs: (element) => (
      hasRichPreContent(element as HTMLElement) ? null : false
    ),
  }],
  renderHTML: ({ HTMLAttributes }) => [
    'pre',
    mergeAttributes(HTMLAttributes),
    0,
  ],
});

const Figure = Node.create({
  name: 'figure',
  group: 'block',
  content: 'block+',
  defining: true,
  parseHTML: () => [{ tag: 'figure' }],
  renderHTML: ({ HTMLAttributes }) => [
    'figure',
    mergeAttributes(HTMLAttributes),
    0,
  ],
});

const Figcaption = Node.create({
  name: 'figcaption',
  group: 'block',
  content: 'inline*',
  defining: true,
  parseHTML: () => [{ tag: 'figcaption' }],
  renderHTML: ({ HTMLAttributes }) => [
    'figcaption',
    mergeAttributes(HTMLAttributes),
    0,
  ],
});

function inertNodeView(label: string, withContent = false) {
  return () => {
    const dom = document.createElement('div');
    dom.className = 'tiptap-embed-placeholder';
    dom.setAttribute('contenteditable', 'false');
    dom.setAttribute('data-embed-label', label);
    dom.textContent = label;
    if (!withContent) return { dom };
    const contentDOM = document.createElement('div');
    contentDOM.hidden = true;
    dom.append(contentDOM);
    return { dom, contentDOM };
  };
}

const Iframe = Node.create({
  name: 'iframe',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes: () => attributes(
    ['width', 'height', 'frameborder', 'title'],
    ['allowfullscreen'],
    ['src'],
  ),
  parseHTML: () => [{ tag: 'iframe[src]' }],
  renderHTML: ({ HTMLAttributes }) => [
    'iframe',
    mergeAttributes(HTMLAttributes),
  ],
  addNodeView: () => inertNodeView('Embedded frame'),
});

const MediaSource = Node.create({
  name: 'mediaSource',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes: () => attributes(
    ['srcset', 'sizes', 'type', 'media', 'width', 'height'],
    [],
    ['src'],
  ),
  parseHTML: () => [{ tag: 'source' }],
  renderHTML: ({ HTMLAttributes }) => [
    'source',
    mergeAttributes(HTMLAttributes),
  ],
});

const MediaTrack = Node.create({
  name: 'mediaTrack',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes: () => attributes(
    ['kind', 'srclang', 'label'],
    ['default'],
    ['src'],
  ),
  parseHTML: () => [{ tag: 'track' }],
  renderHTML: ({ HTMLAttributes }) => [
    'track',
    mergeAttributes(HTMLAttributes),
  ],
});

const Video = Node.create({
  name: 'video',
  group: 'block',
  content: '(mediaSource | mediaTrack | text)*',
  defining: true,
  addAttributes: () => attributes(
    ['controlslist', 'preload', 'width', 'height', 'title'],
    ['controls', 'autoplay', 'loop', 'muted', 'playsinline'],
    ['src', 'poster'],
  ),
  parseHTML: () => [{ tag: 'video' }],
  renderHTML: ({ HTMLAttributes }) => [
    'video',
    mergeAttributes(HTMLAttributes),
    0,
  ],
  addNodeView: () => inertNodeView('Video', true),
});

const Audio = Node.create({
  name: 'audio',
  group: 'block',
  content: '(mediaSource | mediaTrack | text)*',
  defining: true,
  addAttributes: () => attributes(
    ['controlslist', 'preload', 'title'],
    ['controls', 'autoplay', 'loop', 'muted'],
    ['src'],
  ),
  parseHTML: () => [{ tag: 'audio' }],
  renderHTML: ({ HTMLAttributes }) => [
    'audio',
    mergeAttributes(HTMLAttributes),
    0,
  ],
  addNodeView: () => inertNodeView('Audio', true),
});

export const TIPTAP_VISUAL_PROFILE_NAME = 'tiptap-v1' as const;

export function createTiptapVisualExtensions(): Extensions {
  return [
    StarterKit.configure({ link: false }),
    ContractAttributes,
    ContractLink,
    // Compatibility scans replace external image sources with a network-inert
    // data URI before Tiptap parses the document. The src attribute validator
    // still rejects every data URI, so authored data URLs are never retained.
    ContractImage.configure({ allowBase64: true }),
    Table.configure({ resizable: false }),
    TableRow,
    ContractTableHeader,
    ContractTableCell,
    GenericDiv,
    TextStyle.configure({ mergeNestedSpanStyles: true }),
    ContractColor,
    TextAlign.configure({
      types: ['heading', 'paragraph'],
      alignments: [...TIPTAP_TEXT_ALIGNMENTS],
    }),
    GenericSpan,
    RichPre,
    Figure,
    Figcaption,
    Iframe,
    Video,
    Audio,
    MediaSource,
    MediaTrack,
  ];
}
