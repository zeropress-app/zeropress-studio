import { parseFragment, serializeOuter } from 'parse5';

type HtmlNode = {
  nodeName?: string;
  tagName?: string;
  value?: string;
  childNodes?: HtmlNode[];
  [key: string]: unknown;
};

// These Tiptap nodes contain block children. Formatting whitespace between
// those children is ignored by the visual profile, unlike whitespace inside
// paragraphs, preformatted text, and native media elements.
const STRUCTURED_CONTAINER_TAGS = new Set([
  'blockquote',
  'div',
  'figure',
  'li',
  'ol',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

function isFormattingWhitespace(node: HtmlNode): boolean {
  return node.nodeName === '#text' && /^\s*$/u.test(node.value ?? '');
}

function serializeNode(node: HtmlNode): string {
  return serializeOuter(node as never);
}

function formatNode(node: HtmlNode, depth: number): string {
  const indent = '  '.repeat(depth);
  const tag = node.tagName?.toLowerCase();
  if (!tag || !STRUCTURED_CONTAINER_TAGS.has(tag)) {
    return `${indent}${serializeNode(node)}`;
  }

  const children = (node.childNodes ?? []).filter((child) => (
    !isFormattingWhitespace(child)
  ));
  if (children.length === 0) return `${indent}${serializeNode(node)}`;

  const shell = serializeNode({ ...node, childNodes: [] });
  const closingTag = `</${tag}>`;
  if (!shell.endsWith(closingTag)) return `${indent}${serializeNode(node)}`;

  const openingTag = shell.slice(0, -closingTag.length);
  return [
    `${indent}${openingTag}`,
    ...children.map((child) => formatNode(child, depth + 1)),
    `${indent}${closingTag}`,
  ].join('\n');
}

/**
 * Formats canonical Tiptap HTML at semantic block boundaries. It deliberately
 * avoids line wrapping and never inserts whitespace inside inline-content,
 * preformatted, or native media nodes.
 */
export function formatTiptapVisualHtml(html: string): string {
  if (html === '') return '';
  const fragment = parseFragment(html) as unknown as HtmlNode;
  return (fragment.childNodes ?? [])
    .filter((node) => !isFormattingWhitespace(node))
    .map((node) => formatNode(node, 0))
    .join('\n');
}
