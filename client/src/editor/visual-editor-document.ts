import { parseFragment, serialize, serializeOuter } from 'parse5';
import { sanitizeVisualHtml } from './suneditor-compatibility';
import { formatSunEditorVisualHtml } from './visual-html-serialization';
import { normalizeContentTextAlignment, parseContentStyleDeclarations } from './visual-html-policy';

type HtmlNode = {
  nodeName: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
  parentNode?: HtmlNode;
};

export type VisualEmbedStore = Map<string, string>;

/** Embedded players remain inert while editing; their HTML stays in memory. */
export function prepareVisualDocument(html: string, embeds: VisualEmbedStore): string {
  const fragment = parseFragment(sanitizeVisualHtml(html));
  function visit(parent: HtmlNode) {
    parent.childNodes = (parent.childNodes ?? []).map((node) => {
      if (node.tagName && ['iframe', 'video', 'audio'].includes(node.tagName)) {
        const id = crypto.randomUUID();
        embeds.set(id, serializeOuter(node as never));
        const placeholder = parseFragment(
          `<div class="studio-visual-embed-placeholder" contenteditable="false" data-studio-embed="${id}">${node.tagName.toUpperCase()}</div>`,
        ).childNodes[0] as unknown as HtmlNode;
        placeholder.parentNode = parent;
        return placeholder;
      }
      visit(node);
      return node;
    });
  }
  visit(fragment as unknown as HtmlNode);
  return serialize(fragment);
}

export function exportVisualDocument(html: string, embeds: VisualEmbedStore): string {
  const fragment = parseFragment(html);
  function visit(parent: HtmlNode) {
    parent.childNodes = (parent.childNodes ?? []).flatMap((node): HtmlNode[] => {
      const marker = node.attrs?.find((a) => a.name === 'data-studio-embed')?.value;
      if (marker && embeds.has(marker)) {
        return parseFragment(embeds.get(marker)!).childNodes.map((child) => {
          (child as unknown as HtmlNode).parentNode = parent;
          return child as unknown as HtmlNode;
        });
      }
      visit(node);
      // Native table cells and list items can carry alignment on their wrapper.
      // Translate it to the public renderer's cell/paragraph representation.
      const alignment = normalizeContentTextAlignment(parseContentStyleDeclarations(
        node.attrs?.find((a) => a.name === 'style')?.value,
      ).findLast((style) => style.property === 'text-align')?.value);
      if (alignment && (node.tagName === 'th' || node.tagName === 'td')) {
        node.attrs = (node.attrs ?? []).filter((a) => a.name !== 'align');
        node.attrs.push({ name: 'align', value: alignment });
      } else if (alignment && ['div', 'li'].includes(node.tagName ?? '')) {
        const children: HtmlNode[] = [];
        let paragraph: HtmlNode | undefined;
        for (const child of node.childNodes ?? []) {
          const block = child.tagName && /^(p|div|h[1-6]|ul|ol|pre|blockquote|table|figure)$/u.test(child.tagName);
          if (block) { paragraph = undefined; children.push(child); continue; }
          if (!paragraph) {
            paragraph = parseFragment(`<p style="text-align: ${alignment}"></p>`).childNodes[0] as unknown as HtmlNode;
            paragraph.parentNode = node;
            children.push(paragraph);
          }
          child.parentNode = paragraph;
          paragraph.childNodes!.push(child);
        }
        node.childNodes = children;
      }
      const classes = node.attrs?.find((a) => a.name === 'class');
      const tokens = classes?.value.split(/\s+/u) ?? [];
      if (node.tagName === 'colgroup') return [];
      if (node.tagName === 'figure' && tokens.includes('se-flex-component')) {
        return (node.childNodes ?? []).map((child) => ({ ...child, parentNode: parent }));
      }
      if (classes) {
        classes.value = tokens.filter((token) => !/^(__se__|se-)/u.test(token)).join(' ');
        if (!classes.value) node.attrs = node.attrs?.filter((a) => a !== classes);
      }
      return [node];
    });
  }
  visit(fragment as unknown as HtmlNode);
  const cleaned = sanitizeVisualHtml(serialize(fragment));
  return formatSunEditorVisualHtml(cleaned);
}

export type VisualSelectionPoint = { path: number[]; offset: number };

export function selectionPoint(root: Node, node: Node, offset: number): VisualSelectionPoint {
  const path: number[] = [];
  while (node !== root) {
    if (!node.parentNode) throw new TypeError('Selection is outside the editor.');
    path.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes, node));
    node = node.parentNode;
  }
  return { path, offset };
}

export function selectionNode(root: Node, point: VisualSelectionPoint): Node {
  return point.path.reduce((node, index) => {
    const child = node.childNodes[index];
    if (!child) throw new TypeError('The selected content has changed.');
    return child;
  }, root);
}
