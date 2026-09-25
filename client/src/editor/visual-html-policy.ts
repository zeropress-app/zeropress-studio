export const SUNEDITOR_TEXT_ALIGNMENTS = [
  'left',
  'center',
  'right',
  'justify',
] as const;
export type SunEditorTextAlignment = typeof SUNEDITOR_TEXT_ALIGNMENTS[number];

export const SUNEDITOR_IMAGE_ALIGNMENTS = [
  'none',
  'left',
  'center',
  'right',
] as const;
export type SunEditorImageAlignment = typeof SUNEDITOR_IMAGE_ALIGNMENTS[number];

const SUNEDITOR_TEXT_ALIGNMENT_SET = new Set<string>(SUNEDITOR_TEXT_ALIGNMENTS);
const SUNEDITOR_IMAGE_ALIGNMENT_SET = new Set<string>(SUNEDITOR_IMAGE_ALIGNMENTS);
const IMAGE_ALIGNMENT_CLASS = {
  none: 'alignnone',
  left: 'alignleft',
  center: 'aligncenter',
  right: 'alignright',
} satisfies Record<SunEditorImageAlignment, string>;
const IMAGE_ALIGNMENT_BY_CLASS = new Map<string, SunEditorImageAlignment>(
  Object.entries(IMAGE_ALIGNMENT_CLASS).map(([alignment, className]) => [
    className,
    alignment as SunEditorImageAlignment,
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
): SunEditorTextAlignment | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return SUNEDITOR_TEXT_ALIGNMENT_SET.has(normalized)
    ? normalized as SunEditorTextAlignment
    : null;
}

export function normalizeContentImageAlignment(
  value: unknown,
): SunEditorImageAlignment | null {
  return typeof value === 'string' && SUNEDITOR_IMAGE_ALIGNMENT_SET.has(value)
    ? value as SunEditorImageAlignment
    : null;
}

export function imageAlignmentFromClass(value: unknown): SunEditorImageAlignment | null {
  if (typeof value !== 'string') return null;
  const alignments = value.trim().split(/\s+/u).flatMap((className) => {
    const alignment = IMAGE_ALIGNMENT_BY_CLASS.get(className);
    return alignment ? [alignment] : [];
  });
  return alignments.length === 1 ? alignments[0] : null;
}

export function imageClassWithAlignment(
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
 * browser DOM parser sees authored HTML. The marker lets the shared SunEditor
 * profile retain the attribute's schema position without accepting arbitrary
 * data URLs as authored media.
 */
export const SUNEDITOR_INERT_RESOURCE_MARKER_PREFIX = '__zeropress_inert_resource_';
export const SUNEDITOR_INERT_RESOURCE_URL = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

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

