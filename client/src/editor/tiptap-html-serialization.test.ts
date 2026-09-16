import { describe, expect, it } from 'vitest';
import { formatTiptapVisualHtml } from './tiptap-html-serialization';

describe('Tiptap visual HTML serialization', () => {
  it('places semantic block children on deterministic indented lines', () => {
    const source = '<p>One</p><ol><li><p>Two</p></li><li><p>Three</p></li></ol><p>Four</p>';
    expect(formatTiptapVisualHtml(source)).toBe([
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
    const formatted = formatTiptapVisualHtml(source);
    expect(formatted).toContain('<p>Before<br>After</p>');
    expect(formatted).toContain('<a href="/full"><img src="/photo.png"></a>');
    expect(formatted).toContain('<pre>one\ntwo</pre>');
    expect(formatTiptapVisualHtml(formatted)).toBe(formatted);
  });

  it('uses no trailing newline and keeps empty HTML canonical', () => {
    expect(formatTiptapVisualHtml('')).toBe('');
    expect(formatTiptapVisualHtml('<p>Text</p>')).not.toMatch(/\n$/u);
  });
});
