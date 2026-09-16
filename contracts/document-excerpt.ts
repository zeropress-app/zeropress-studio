import { decodeHTMLStrict } from 'entities/decode';

export type PreviewDocumentType = 'plaintext' | 'markdown' | 'html';

type ComputeImportedHtmlExcerptInput = {
  excerpt?: string | null;
  metaDescription?: string | null;
  candidateMaximum: number;
};

const BLOCK_TAG_NAMES = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'col',
  'colgroup', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'head', 'header', 'html', 'li', 'main', 'menu', 'nav', 'ol', 'p',
  'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'tr', 'ul',
]);
const LINE_BREAK_TAG_NAMES = new Set(['br', 'hr']);
function normalizeSafePlainText(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return decodeHTMLStrict(value);
}

function looksLikeHtmlMarkupStart(value: string, start: number): boolean {
  const next = value[start + 1] ?? '';
  if (/[A-Za-z!?]/u.test(next)) return true;
  return next === '/' && /[A-Za-z]/u.test(value[start + 2] ?? '');
}

function scanHtmlTag(value: string, start: number): {
  name: string;
  closing: boolean;
  end: number;
} | null {
  let index = start + 1;
  let quote = '';
  while (index < value.length) {
    const character = value[index];
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      const body = value.slice(start + 1, index).trim();
      const closing = body.startsWith('/');
      const source = body.slice(closing ? 1 : 0).trimStart();
      const name = /^[A-Za-z][A-Za-z0-9:-]*/u.exec(source)?.[0]
        ?.toLowerCase() ?? '';
      return { name, closing, end: index + 1 };
    }
    index += 1;
  }
  return null;
}

function asciiCaseInsensitiveMatch(
  value: string,
  start: number,
  expected: string,
): boolean {
  if (start + expected.length > value.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (value[start + index]?.toLowerCase() !== expected[index]) return false;
  }
  return true;
}

function findRawTextElementEnd(
  value: string,
  start: number,
  tagName: string,
): number | null {
  for (let index = start; index < value.length; index += 1) {
    if (value[index] !== '<' || value[index + 1] !== '/') continue;
    if (!asciiCaseInsensitiveMatch(value, index + 2, tagName)) continue;
    let end = index + 2 + tagName.length;
    const boundary = value[end];
    if (boundary && !/[\s>]/u.test(boundary)) continue;
    while (/\s/u.test(value[end] ?? '')) end += 1;
    if (value[end] === '>') return end + 1;
  }
  return null;
}

function decodeHtmlEntityAt(value: string, start: number): {
  value: string;
  end: number;
} | null {
  const maximumEnd = Math.min(value.length, start + 34);
  let semicolon = -1;
  for (let index = start + 1; index < maximumEnd; index += 1) {
    if (value[index] === ';') {
      semicolon = index;
      break;
    }
  }
  if (semicolon < 0) return null;
  const candidate = value.slice(start, semicolon + 1);
  const decoded = decodeHtmlEntities(candidate);
  return decoded === candidate
    ? null
    : { value: decoded, end: semicolon + 1 };
}

function htmlToPlainText(value: string, scanLimit: number): string {
  const html = String(value || '');
  let output = '';
  let pendingWhitespace = false;
  let index = 0;

  const appendWhitespace = () => {
    if (output) pendingWhitespace = true;
  };
  const appendVisible = (text: string) => {
    for (
      let offset = 0;
      offset < text.length && output.length < scanLimit;
      offset += 1
    ) {
      const character = text[offset]!;
      if (/\s/u.test(character)) {
        appendWhitespace();
        continue;
      }
      const code = character.charCodeAt(0);
      if (
        (code >= 0 && code <= 8)
        || code === 11
        || code === 12
        || (code >= 14 && code <= 31)
        || code === 127
      ) continue;
      if (pendingWhitespace && output.length < scanLimit) {
        if (output.length === scanLimit - 1) {
          output += character;
          pendingWhitespace = false;
          continue;
        }
        output += ' ';
      }
      pendingWhitespace = false;
      if (output.length < scanLimit) output += character;
    }
  };

  while (index < html.length && output.length < scanLimit) {
    if (html.startsWith('<!--', index)) {
      const commentEnd = html.indexOf('-->', index + 4);
      if (commentEnd < 0) break;
      appendWhitespace();
      index = commentEnd + 3;
      continue;
    }
    if (html[index] === '<' && looksLikeHtmlMarkupStart(html, index)) {
      const tag = scanHtmlTag(html, index);
      if (!tag) {
        appendVisible(html[index]!);
        index += 1;
        continue;
      }
      if (!tag.closing && (tag.name === 'script' || tag.name === 'style')) {
        const rawTextEnd = findRawTextElementEnd(html, tag.end, tag.name);
        if (rawTextEnd === null) break;
        appendWhitespace();
        index = rawTextEnd;
        continue;
      }
      if (
        BLOCK_TAG_NAMES.has(tag.name)
        || LINE_BREAK_TAG_NAMES.has(tag.name)
      ) appendWhitespace();
      index = tag.end;
      continue;
    }
    if (html[index] === '&') {
      const entity = decodeHtmlEntityAt(html, index);
      if (entity) {
        appendVisible(entity.value);
        index = entity.end;
        continue;
      }
    }
    appendVisible(html[index]!);
    index += 1;
  }
  return output.trim();
}

function markdownToPlainText(value: string): string {
  let next = value.replace(/\r\n?/gu, '\n');
  next = next.replace(/<(https?:\/\/[^>\s]+)>/giu, '$1');
  next = next.replace(/<([^\s>]+@[^\s>]+)>/gu, '$1');
  next = next.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ' ');
  next = next.replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ');
  next = next.replace(/<\/?[^>]+>/gu, ' ');
  next = next.replace(/^```[^\n]*$/gmu, ' ');
  next = next.replace(/^~~~[^\n]*$/gmu, ' ');
  next = next.replace(/!\[([^\]]*)\]\([^)]+\)/gu, '$1');
  next = next.replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1');
  next = next.replace(/!\[([^\]]*)\]\[[^\]]*\]/gu, '$1');
  next = next.replace(/\[([^\]]+)\]\[[^\]]*\]/gu, '$1');
  next = next.replace(/^\s{0,3}[-*+]\s+\[[ xX]\]\s+/gmu, '');
  next = next.replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gmu, '');
  next = next.replace(/^\s{0,3}#{1,6}\s+/gmu, '');
  next = next.replace(/^\s{0,3}>\s?/gmu, '');
  next = next.replace(/^\s{0,3}(?:---|\*\*\*|___)\s*$/gmu, ' ');
  next = next.replace(/`{1,3}([^`]+)`{1,3}/gu, '$1');
  next = next.replace(/(\*\*|__)(.*?)\1/gu, '$2');
  next = next.replace(/(\*|_)(.*?)\1/gu, '$2');
  next = next.replace(/~~(.*?)~~/gu, '$1');
  next = next.replace(/\\([\\`*_{}\[\]()#+\-.!>])/gu, '$1');
  return normalizeSafePlainText(decodeHtmlEntities(next));
}

function contentToPlainText(
  content: string,
  documentType: PreviewDocumentType,
  scanLimit: number,
): string {
  if (documentType === 'html') return htmlToPlainText(content, scanLimit);
  if (documentType === 'plaintext') return normalizeSafePlainText(content);
  return markdownToPlainText(content);
}

export function computeDocumentSearchText(input: {
  content: string;
  documentType: PreviewDocumentType;
}): string {
  return contentToPlainText(
    input.content,
    input.documentType,
    Number.MAX_SAFE_INTEGER,
  );
}

export function computeImportedHtmlExcerpt({
  excerpt,
  metaDescription,
  candidateMaximum,
}: ComputeImportedHtmlExcerptInput): string {
  const candidateScanLimit = candidateMaximum + 1;
  const explicit = htmlToPlainText(excerpt ?? '', candidateScanLimit);
  if (explicit) return explicit;
  const metadata = htmlToPlainText(metaDescription ?? '', candidateScanLimit);
  if (metadata) return metadata;
  return '';
}
