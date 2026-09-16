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
});
