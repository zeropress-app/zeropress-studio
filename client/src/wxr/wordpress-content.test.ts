import { describe, expect, it } from 'vitest';
import { materializeWordPressClassicHtml } from './wordpress-content';

describe('WordPress classic WXR content materialization', () => {
  it('materializes authored soft breaks and blank-line paragraphs', () => {
    expect(materializeWordPressClassicHtml('<p>첫 줄\n둘째 줄</p>'))
      .toBe('<p>첫 줄<br />\n둘째 줄</p>');
    expect(materializeWordPressClassicHtml('첫 문단\n둘째 줄\n\n새 문단'))
      .toBe('<p>첫 문단<br />\n둘째 줄</p>\n<p>새 문단</p>');
  });

  it('preserves block, raw, and multiline-tag structure', () => {
    expect(materializeWordPressClassicHtml('<ol>\n  <li>One</li>\n  <li>Two</li>\n</ol>'))
      .toBe('<ol>\n<li>One</li>\n<li>Two</li>\n</ol>');
    expect(materializeWordPressClassicHtml('<pre>one\ntwo</pre>'))
      .toBe('<pre>one\ntwo</pre>');
    expect(materializeWordPressClassicHtml(
      '<p><a href="https://example.com"\n  title="Example">Link</a></p>',
    )).toBe('<p><a href="https://example.com"\n  title="Example">Link</a></p>');
  });

  it('bypasses Gutenberg blocks', () => {
    const source = '<!-- wp:paragraph -->\n<p>One\nTwo</p>\n<!-- /wp:paragraph -->';
    expect(materializeWordPressClassicHtml(source)).toBe(source);
  });
});
