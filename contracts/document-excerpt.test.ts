import { describe, expect, it } from 'vitest';
import {
  computeDocumentSearchText,
  computeImportedHtmlExcerpt,
} from './document-excerpt';

describe('Document text projection policy', () => {
  it('uses WXR excerpt, then SEO metadata, without body fallback', () => {
    expect(computeImportedHtmlExcerpt({
      excerpt: '<b>WordPress excerpt</b>',
      metaDescription: 'SEO summary',
      candidateMaximum: 500,
    })).toBe('WordPress excerpt');
    expect(computeImportedHtmlExcerpt({
      excerpt: '',
      metaDescription: 'SEO&nbsp;summary',
      candidateMaximum: 500,
    })).toBe('SEO summary');
    expect(computeImportedHtmlExcerpt({
      excerpt: '',
      metaDescription: '',
      candidateMaximum: 500,
    })).toBe('');
  });

  it('projects only reader-visible text for the full search index', () => {
    expect(computeDocumentSearchText({
      content: '<article data-secret="attribute-only"><p>Caf&eacute; &amp; tea</p><!-- hidden --><script>privateToken()</script><style>.private-style{}</style></article>',
      documentType: 'html',
    })).toBe('Café & tea');
    expect(computeDocumentSearchText({
      content: '# Guide\n\nRead [the visible label](https://private.example/path) and ![diagram alt](https://private.example/image.png).',
      documentType: 'markdown',
    })).toBe('Guide Read the visible label and diagram alt.');
    expect(computeDocumentSearchText({
      content: '  Plain\u0000\n\ntext\tcontent.  ',
      documentType: 'plaintext',
    })).toBe('Plain text content.');
  });

  describe.each(['html', 'markdown'] as const)('%s HTML text extraction', (documentType) => {
    it.each([
      ['Before<script>hidden()</script >after', 'Before after'],
      ['Before<SCRIPT data-check="1 > 0">hidden()</SCRIPT data-end=">">after', 'Before after'],
      ['<style>.hidden { color: red }</style\t>Visible', 'Visible'],
      ['Before<script>hidden()', 'Before'],
      ['A<!-- hidden > remainder --!>B', 'A B'],
      ['<span title="1 > 0">Visible</span> text', 'Visible text'],
      ['Visible<template>hidden</template>after', 'Visible after'],
      ['<p>&amp;lt;b&amp;gt; &#38;lt;i&#38;gt; &#42;literal&#42;</p>', '&lt;b&gt; &lt;i&gt; *literal*'],
      ['&lt;img src=x onerror=example&gt;', '<img src=x onerror=example>'],
      ['2 < 3 and 5 > 4', '2 < 3 and 5 > 4'],
    ])('preserves the intended plain text from %s', (content, expected) => {
      expect(computeDocumentSearchText({ content, documentType })).toBe(expected);
    });
  });

  it('keeps Markdown line structure until headings, lists and quotes are projected', () => {
    expect(computeDocumentSearchText({
      content: '# Guide\n\n- **First**\n- [Second](https://example.com)\n> Quote\n\n<https://example.com/path> <reader@example.com>',
      documentType: 'markdown',
    })).toBe('Guide First Second Quote https://example.com/path reader@example.com');
  });

  it('bounds imported excerpts after decoding text and skips hidden contents', () => {
    expect(computeImportedHtmlExcerpt({
      excerpt: '<script>hidden()</script data-end=">"><p>Caf&eacute; &amp; tea</p>',
      candidateMaximum: 7,
    })).toBe('Café & t');
  });
});
