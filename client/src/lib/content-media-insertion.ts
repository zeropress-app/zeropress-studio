import {
  createManagedMediaReference,
  type Media,
} from '../../../contracts/media';

export type ContentDocumentType = 'markdown' | 'html' | 'plaintext';

export function contentMediaSource(media: Media): string {
  return media.location.type === 'external'
    ? media.location.url
    : createManagedMediaReference(media.location.key);
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeHtmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeMarkdownLabel(value: string): string {
  return value
    .replace(/[\r\n]+/gu, ' ')
    .replaceAll('\\', '\\\\')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]');
}

function htmlDimensionAttributes(media: Media): string {
  return media.width !== null && media.height !== null
    ? ` width="${media.width}" height="${media.height}"`
    : '';
}

export function createContentMediaSnippet(
  media: Media,
  documentType: ContentDocumentType,
): string {
  const source = contentMediaSource(media);
  if (documentType === 'plaintext') return source;

  if (documentType === 'markdown') {
    const label = escapeMarkdownLabel(
      media.kind === 'image' ? media.alt : media.filename,
    );
    return media.kind === 'image'
      ? `![${label}](<${source}>)`
      : `[${label}](<${source}>)`;
  }

  const escapedSource = escapeHtmlAttribute(source);
  if (media.kind === 'image') {
    return `<img src="${escapedSource}" alt="${escapeHtmlAttribute(media.alt)}"${htmlDimensionAttributes(media)} loading="lazy" decoding="async">`;
  }
  if (media.kind === 'video') {
    return `<video controls preload="metadata" src="${escapedSource}"${htmlDimensionAttributes(media)}></video>`;
  }
  if (media.kind === 'audio') {
    return `<audio controls preload="metadata" src="${escapedSource}"></audio>`;
  }
  return `<a href="${escapedSource}">${escapeHtmlText(media.filename)}</a>`;
}

export function insertTextAtSelection(input: {
  value: string;
  insertion: string;
  selectionStart: number;
  selectionEnd: number;
}): { value: string; cursor: number } {
  const boundedStart = Math.min(
    input.value.length,
    Math.max(0, Math.trunc(input.selectionStart)),
  );
  const boundedEnd = Math.min(
    input.value.length,
    Math.max(0, Math.trunc(input.selectionEnd)),
  );
  const start = Math.min(boundedStart, boundedEnd);
  const end = Math.max(boundedStart, boundedEnd);
  return {
    value: `${input.value.slice(0, start)}${input.insertion}${input.value.slice(end)}`,
    cursor: start + input.insertion.length,
  };
}
