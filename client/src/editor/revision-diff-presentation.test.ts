import { describe, expect, it } from 'vitest';
import {
  prepareRevisionDiffPresentation,
  projectVisualHtmlForRevisionDiff,
} from './revision-diff-presentation';

describe('visual HTML revision diff projection', () => {
  it('adds logical lines at Tiptap block boundaries and preserves inline HTML', () => {
    const html = '<p>First <a href="/one" title="1 > 0"><strong>link</strong></a></p><h2>Heading</h2><ul><li>One</li><li>Two</li></ul><figure><img src="/image.png"><figcaption>Caption</figcaption></figure>';

    expect(projectVisualHtmlForRevisionDiff(html)).toBe([
      '<p>First <a href="/one" title="1 > 0"><strong>link</strong></a></p>',
      '<h2>Heading</h2>',
      '<ul>',
      '<li>One</li>',
      '<li>Two</li>',
      '</ul>',
      '<figure>',
      '<img src="/image.png">',
      '<figcaption>Caption</figcaption>',
      '</figure>',
      '',
    ].join('\n'));
  });

  it('keeps whitespace-sensitive content and existing source bytes', () => {
    const html = '<pre>line 1\nline 2 <a href="/raw">link</a></pre><p>a<br>b</p><!-- <p>not a tag</p> -->';

    const projected = projectVisualHtmlForRevisionDiff(html);
    expect(projected).toBe([
      '<pre>line 1',
      'line 2 <a href="/raw">link</a></pre>',
      '<p>a<br>',
      'b</p>',
      '<!-- <p>not a tag</p> -->',
    ].join('\n'));
    expect(projectVisualHtmlForRevisionDiff(projected)).toBe(projected);
  });

  it('projects only a pair of visual tiptap-v1 HTML revisions', () => {
    const compact = '<p>One</p><p>Two</p>';
    const visual = {
      content: compact,
      documentType: 'html' as const,
      editorMode: 'visual' as const,
      editorProfile: 'tiptap-v1' as const,
    };
    expect(prepareRevisionDiffPresentation({
      original: visual,
      modified: { ...visual, content: '<p>One</p><p>Changed</p>' },
    })).toEqual({
      original: '<p>One</p>\n<p>Two</p>\n',
      modified: '<p>One</p>\n<p>Changed</p>\n',
    });

    expect(prepareRevisionDiffPresentation({
      original: visual,
      modified: {
        content: compact,
        documentType: 'html',
        editorMode: 'source',
        editorProfile: null,
      },
    })).toEqual({ original: compact, modified: compact });
  });
});
