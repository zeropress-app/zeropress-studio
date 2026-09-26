// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createContentPreviewDocument } from './content-preview-document';
import type { ContentPreviewRequest } from './content-preview';

const source: ContentPreviewRequest = {
  title: 'Unsaved title', content: '', documentType: 'html',
  baseUrl: 'https://site.example/articles/saved/', language: 'en', dark: false,
  labels: {
    linkDetails: 'Link details', address: 'Address', target: 'Opens in',
    newWindow: 'New window (_blank)', sameWindow: 'Current window',
    embedTitle: 'External content', embedUnavailable: 'Not loaded in this preview.',
    missingAddress: 'Address not available', close: 'Close',
  },
};
function render(input: Partial<ContentPreviewRequest>) {
  return new DOMParser().parseFromString(createContentPreviewDocument({ ...source, ...input }), 'text/html');
}

describe('body preview document', () => {
  it('renders editor code and tables with the public content renderer', () => {
    const doc = render({ content: '<pre class="language-javascript">const n = 42;<br>alert(n);<br></pre><table><tr><th>Item</th><td>Value</td></tr></table>' });
    expect(doc.querySelector('pre > code')?.textContent).toBe('const n = 42;\nalert(n);\n');
    expect(doc.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(doc.querySelector('th')?.textContent).toBe('Item');
    expect(doc.querySelector('h1')?.textContent).toBe('Unsaved title');
  });

  it('renders Markdown formatting and keeps plaintext literal', () => {
    const markdown = render({ documentType: 'markdown', content: '## Heading\n\n**Strong**\n\n```js\nconst n = 1;\n```' });
    expect(markdown.querySelector('h2')?.textContent).toBe('Heading');
    expect(markdown.querySelector('strong')?.textContent).toBe('Strong');
    expect(markdown.querySelector('code .hljs-number')?.textContent).toBe('1');
    const plain = render({ documentType: 'plaintext', content: '<script>sample</script>\n\nSecond paragraph' });
    expect(plain.querySelector('.prose p')?.textContent).toBe('<script>sample</script>');
    expect(plain.querySelectorAll('.prose p')).toHaveLength(2);
  });

  it('keeps authored active content outside the Studio origin and escapes the title', () => {
    const doc = render({ title: '</h1><img src=x onerror=bad()>', content: '<script>bad()</script><a href="/admin">Read</a><iframe src="https://embed.example/"></iframe><img src="javascript:bad()" onerror="bad()"><input type="checkbox"><video src="/clip.mp4" autoplay></video>' });
    expect(doc.querySelector('h1')?.textContent).toBe('</h1><img src=x onerror=bad()>');
    expect(doc.querySelector('.preview-embed strong')?.textContent).toBe('External content');
    expect(doc.querySelector('.preview-embed .preview-url')?.textContent).toBe('https://embed.example/');
    expect(doc.querySelectorAll('script, iframe, [href], [onerror], [autoplay]')).toHaveLength(0);
    expect(doc.querySelector('input')?.disabled).toBe(true);
    expect(doc.querySelector('video')?.getAttribute('preload')).toBe('none');
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("script-src 'none'");
  });

  it('provides inert link details from the rendered URL and target while preserving link content', () => {
    const href = 'https://destination.example/article?q=<sample>&next="quoted"';
    const doc = render({ content: '<p><a id="article" class="custom-link" href="https://destination.example/article?q=&lt;sample&gt;&amp;next=&quot;quoted&quot;" target="_blank"><strong>Read more</strong></a></p><a href="../related">Related</a><a href="#section" target="_self">Section</a>' });
    const controls = [...doc.querySelectorAll<HTMLButtonElement>('button.preview-link')];
    expect(controls).toHaveLength(3);
    expect(controls[0].id).toBe('article');
    expect(controls[0].classList.contains('custom-link')).toBe(true);
    expect(controls[0].querySelector('strong')?.textContent).toBe('Read more');
    const targets = controls.map((button) => button.getAttribute('popovertarget')!);
    expect(new Set(targets).size).toBe(3);
    const details = targets.map((id) => doc.getElementById(id)!);
    expect(details[0].getAttribute('popover')).toBe('auto');
    expect(details.map((node) => node.querySelector('.preview-url')?.textContent)).toEqual([href, '../related', '#section']);
    expect(details.map((node) => node.querySelectorAll('dd')[1].textContent)).toEqual(['New window (_blank)', 'Current window', 'Current window']);
    expect(details[0].querySelector('button')?.getAttribute('popovertarget')).toBe(targets[0]);
    expect(details[0].querySelector('button')?.getAttribute('popovertargetaction')).toBe('hide');
    expect(doc.querySelectorAll('[href], [target], script')).toHaveLength(0);
  });

  it('shows embed titles and source addresses as escaped selectable text, with missing-value fallbacks', () => {
    const doc = render({ content: '<p><iframe title="&lt;img src=x onerror=bad()&gt;" src="https://embed.example/player?a=1&amp;b=2"></iframe></p><iframe src="/relative-player"></iframe><iframe src="javascript:bad()"></iframe>' });
    const cards = [...doc.querySelectorAll('.preview-embed')];
    expect(cards).toHaveLength(3);
    expect(cards.map((node) => node.querySelector('strong')?.textContent)).toEqual(['<img src=x onerror=bad()>', 'External content', 'External content']);
    expect(cards.map((node) => node.querySelector('.preview-url')?.textContent)).toEqual(['https://embed.example/player?a=1&b=2', '/relative-player', 'Address not available']);
    expect(cards[0].querySelector('.preview-embed-note')?.textContent).toBe('Not loaded in this preview.');
    expect(doc.querySelectorAll('iframe, img, script, [src]')).toHaveLength(0);
  });

  it('inspects rendered Markdown links and keeps rejected destinations inert', () => {
    const doc = render({ documentType: 'markdown', content: '[Email](mailto:editor@example.com)\n\n<a href="javascript:bad()">Rejected</a>' });
    expect(doc.querySelector('button.preview-link')?.textContent).toBe('Email');
    expect(doc.querySelector('.preview-link-details .preview-url')?.textContent).toBe('mailto:editor@example.com');
    expect(doc.querySelectorAll('button.preview-link')).toHaveLength(1);
    expect(doc.querySelector('a')?.textContent).toBe('Rejected');
    expect(doc.querySelector('a')?.hasAttribute('href')).toBe(false);
  });

  it('resolves relative image sources against the public document and preserves responsive sources', () => {
    const doc = render({ content: '<picture><source srcset="../wide.png 2x, /small.png 1x"><img src="photo.png" srcset="/one.png 400w, /two.png 800w"></picture>' });
    expect(doc.querySelector('img')?.getAttribute('src')).toBe('https://site.example/articles/saved/photo.png');
    expect(doc.querySelector('source')?.getAttribute('srcset')).toBe('https://site.example/articles/wide.png 2x, https://site.example/small.png 1x');
    expect(doc.querySelector('img')?.getAttribute('srcset')).toBe('https://site.example/one.png 400w, https://site.example/two.png 800w');
  });

  it('does not resolve missing public URLs against the Studio application', () => {
    const doc = render({ baseUrl: '', content: '<img src="/api/media/private"><img src="https://images.example/a.png">' });
    expect(doc.querySelector('img')?.hasAttribute('src')).toBe(false);
    expect(doc.querySelectorAll('img')[1].getAttribute('src')).toBe('https://images.example/a.png');
  });

  it('carries the chosen language and appearance without modifying input', () => {
    const input = { ...source, dark: true, language: 'ko', content: '<p>본문</p>' };
    const before = { ...input };
    const doc = new DOMParser().parseFromString(createContentPreviewDocument(input), 'text/html');
    expect(doc.documentElement.lang).toBe('ko');
    expect(doc.documentElement.dataset.theme).toBe('dark');
    expect(input).toEqual(before);
  });
});
