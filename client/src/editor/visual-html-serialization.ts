import { parseFragment, serializeOuter } from 'parse5';

type HtmlNode = {
  nodeName?: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  value?: string;
  childNodes?: HtmlNode[];
  [key: string]: unknown;
};

// These SunEditor nodes contain block children. Formatting whitespace between
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

const BLOCK_CHILD_TAGS = new Set([
  ...STRUCTURED_CONTAINER_TAGS, 'p', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
]);

function isFormattingWhitespace(node: HtmlNode): boolean {
  return node.nodeName === '#text' && /^\s*$/u.test(node.value ?? '');
}

function isEmptyParagraph(node: HtmlNode): boolean {
  if (node.tagName !== 'p' || node.attrs?.length) return false;
  const children = node.childNodes ?? [];
  if (children.length === 0) return true;
  const [child] = children;
  return children.length === 1 && child.tagName === 'br'
    && !child.attrs?.length && !child.childNodes?.length;
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
  if (children.length === 0 || children.some((child) =>
    child.nodeName === '#text' || (child.tagName && !BLOCK_CHILD_TAGS.has(child.tagName)))) return `${indent}${serializeNode(node)}`;

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
 * Formats canonical SunEditor HTML at semantic block boundaries. It deliberately
 * avoids line wrapping and never inserts whitespace inside inline-content,
 * preformatted, or native media nodes. Empty editor paragraphs normalize to
 * empty HTML; paragraphs with attributes or authored content remain intact.
 */
export function formatSunEditorVisualHtml(html: string): string {
  if (html === '') return '';
  const fragment = parseFragment(html) as unknown as HtmlNode;
  const children = (fragment.childNodes ?? [])
    .filter((node) => !isFormattingWhitespace(node));
  if (children.every(isEmptyParagraph)) return '';
  return children
    .map((node) => formatNode(node, 0))
    .join('\n');
}
