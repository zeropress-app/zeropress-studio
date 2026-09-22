import { defaultTreeAdapter, parseFragment, type DefaultTreeAdapterMap } from 'parse5';

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

function htmlToPlainText(value: string, scanLimit: number): string {
  const fragment = parseFragment(String(value || ''));
  const pending: (DefaultTreeAdapterMap['childNode'] | null)[] = [...fragment.childNodes].reverse();
  let output = '';
  let pendingWhitespace = false;

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

  // Extract text without serializing or reparsing it; the parser decodes entities once.
  while (pending.length > 0 && output.length < scanLimit) {
    const node = pending.pop()!;
    if (node === null) {
      appendWhitespace();
      continue;
    }
    if (defaultTreeAdapter.isTextNode(node)) {
      appendVisible(node.value);
      continue;
    }
    if (!defaultTreeAdapter.isElementNode(node)) {
      appendWhitespace();
      continue;
    }
    if (node.tagName === 'script' || node.tagName === 'style' || node.tagName === 'template') {
      appendWhitespace();
      continue;
    }
    if (BLOCK_TAG_NAMES.has(node.tagName)) {
      appendWhitespace();
      pending.push(null);
    } else if (LINE_BREAK_TAG_NAMES.has(node.tagName)) {
      appendWhitespace();
    }
    for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
      pending.push(node.childNodes[index]);
    }
  }
  return output.trim();
}

function markdownToPlainText(value: string): string {
  let next = value.replace(/\r\n?/gu, '\n');
  next = next.replace(/<(https?:\/\/[^>\s]+)>/giu, '$1');
  next = next.replace(/<([^\s>]+@[^\s>]+)>/gu, '$1');
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
  return htmlToPlainText(next, Number.MAX_SAFE_INTEGER);
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
