import { renderDocumentContent } from '@zeropress/build-core/content';
import { parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5';
import parseSrcset from 'parse-srcset';
import previewStyles from './content-preview-body.css?inline';
import type { ContentPreviewRequest } from './content-preview';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function resolveMediaUrl(value: string, baseUrl: string): string | null {
  try {
    const url = baseUrl ? new URL(value, baseUrl) : new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href : null;
  } catch { return null; }
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((entry) => entry.name === name)?.value;
}

function setChildren(element: Element, html: string) {
  element.childNodes = parseFragment(html).childNodes;
  for (const child of element.childNodes) child.parentNode = element;
}

function linkDetails(id: string, href: string, target: string | undefined, labels: ContentPreviewRequest['labels']): string {
  return `<aside id="${id}" class="preview-link-details" popover="auto" role="dialog" aria-labelledby="${id}-title">
<h2 id="${id}-title" tabindex="-1" autofocus>${escapeHtml(labels.linkDetails)}</h2>
<dl><div><dt>${escapeHtml(labels.address)}</dt><dd><code class="preview-url" dir="ltr" tabindex="0">${escapeHtml(href || '""')}</code></dd></div>
<div><dt>${escapeHtml(labels.target)}</dt><dd>${escapeHtml(target === '_blank' ? labels.newWindow : labels.sameWindow)}</dd></div></dl>
<button type="button" class="preview-info-close" popovertarget="${id}" popovertargetaction="hide">${escapeHtml(labels.close)}</button>
</aside>`;
}

/** Studio's CSP forbids base elements, so relative media URLs are resolved explicitly. */
function preparePreviewHtml(html: string, input: ContentPreviewRequest): string {
  const fragment = parseFragment(html);
  const stack: Node[] = [...fragment.childNodes];
  const popovers: string[] = [];
  const idPrefix = `preview-link-${crypto.randomUUID()}`;
  while (stack.length) {
    const node = stack.pop()!;
    if ('tagName' in node) {
      const element = node as Element;
      if (element.tagName === 'iframe') {
        const title = attribute(element, 'title')?.trim() || input.labels.embedTitle;
        const src = attribute(element, 'src');
        element.tagName = element.nodeName = 'span';
        element.attrs = [{ name: 'class', value: 'preview-embed' }];
        setChildren(element, `<span class="preview-embed-heading">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="2" y="3" width="20" height="18" rx="2"/><path d="m8 9-3 3 3 3m8-6 3 3-3 3"/></svg>
<strong>${escapeHtml(title)}</strong></span>
<code class="preview-url" dir="ltr">${escapeHtml(src || input.labels.missingAddress)}</code>
<span class="preview-embed-note">${escapeHtml(input.labels.embedUnavailable)}</span>`);
      } else {
        const href = attribute(element, 'href');
        if (element.tagName === 'a' && href !== undefined) {
          const id = `${idPrefix}-${popovers.length}`;
          const className = [attribute(element, 'class'), 'preview-link'].filter(Boolean).join(' ');
          popovers.push(linkDetails(id, href, attribute(element, 'target'), input.labels));
          element.tagName = element.nodeName = 'button';
          element.attrs = element.attrs.filter((entry) => entry.name !== 'class');
          element.attrs.push(
            { name: 'type', value: 'button' },
            { name: 'class', value: className },
            { name: 'popovertarget', value: id },
            { name: 'aria-description', value: input.labels.linkDetails },
          );
        }
        element.attrs = element.attrs.flatMap((attribute) => {
          if (['autoplay', 'preload', 'target', 'rel'].includes(attribute.name)) return [];
          // Destinations are displayed as text; preview controls never navigate.
          if (attribute.name === 'href') return [];
          if (['src', 'poster'].includes(attribute.name)) {
            const value = resolveMediaUrl(attribute.value, input.baseUrl);
            return value ? [{ ...attribute, value }] : [];
          }
          if (attribute.name === 'srcset') {
            const value = parseSrcset(attribute.value).flatMap((candidate) => {
              const url = resolveMediaUrl(candidate.url, input.baseUrl);
              if (!url) return [];
              return [url + (candidate.w ? ` ${candidate.w}w` : candidate.d ? ` ${candidate.d}x` : '')];
            }).join(', ');
            return value ? [{ ...attribute, value }] : [];
          }
          return [attribute];
        });
        if (['video', 'audio'].includes(element.tagName)) {
          element.attrs.push({ name: 'preload', value: 'none' });
        }
        if (element.tagName === 'input' && !element.attrs.some((a) => a.name === 'disabled')) {
          element.attrs.push({ name: 'disabled', value: '' });
        }
      }
    }
    if ('childNodes' in node) {
      for (const child of node.childNodes) stack.push(child);
    }
  }
  return serialize(fragment) + popovers.join('');
}

export function createContentPreviewDocument(input: ContentPreviewRequest): string {
  const body = preparePreviewHtml(renderDocumentContent(input.content, input.documentType), input);
  return `<!doctype html><html lang="${escapeHtml(input.language)}"${input.dark ? ' data-theme="dark"' : ''}>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src http: https:; media-src http: https:; frame-src 'none'; form-action 'none'; base-uri 'none'">
<title>${escapeHtml(input.title)}</title><style>${previewStyles}</style></head>
<body><article><h1>${escapeHtml(input.title)}</h1><div class="prose">${body}</div></article></body></html>`;
}
