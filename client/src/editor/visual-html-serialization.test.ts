import { describe, expect, it } from 'vitest';
import { formatSunEditorVisualHtml } from './visual-html-serialization';

describe('SunEditor visual HTML serialization', () => {
  it('places semantic block children on deterministic indented lines', () => {
    const source = '<p>One</p><ol><li><p>Two</p></li><li><p>Three</p></li></ol><p>Four</p>';
    expect(formatSunEditorVisualHtml(source)).toBe([
      '<p>One</p>',
      '<ol>',
      '  <li>',
      '    <p>Two</p>',
      '  </li>',
      '  <li>',
      '    <p>Three</p>',
      '  </li>',
      '</ol>',
      '<p>Four</p>',
    ].join('\n'));
  });

  it('does not insert whitespace into linked images, hard breaks, or preformatted text', () => {
    const source = '<p>Before<br>After</p><a href="/full"><img src="/photo.png"></a><pre>one\ntwo</pre>';
    const formatted = formatSunEditorVisualHtml(source);
    expect(formatted).toContain('<p>Before<br>After</p>');
    expect(formatted).toContain('<a href="/full"><img src="/photo.png"></a>');
    expect(formatted).toContain('<pre>one\ntwo</pre>');
    expect(formatSunEditorVisualHtml(formatted)).toBe(formatted);
  });

  it('uses no trailing newline and keeps empty HTML canonical', () => {
    expect(formatSunEditorVisualHtml('')).toBe('');
    expect(formatSunEditorVisualHtml('<p>Text</p>')).not.toMatch(/\n$/u);
  });

  it.each(['<p></p>', '<p><br></p>', '\n<p></p>\t <p><br></p>\n'])(
    'normalizes empty editor paragraphs: %j', (html) => {
      expect(formatSunEditorVisualHtml(html)).toBe('');
    },
  );

  it.each([
    '<p id="anchor"></p>',
    '<p><br id="anchor"></p>',
    '<p> </p>',
    '<p>&nbsp;</p>',
    '<p><br><br></p>',
    '<p><img src="/image.png"></p>',
  ])('preserves paragraph content and attributes: %j', (html) => {
    expect(formatSunEditorVisualHtml(html)).toBe(html);
  });
});
