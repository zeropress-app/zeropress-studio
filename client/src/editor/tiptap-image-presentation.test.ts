import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CONTENT_EDITOR_CSS = readFileSync(fileURLToPath(new URL(
  '../screens/content-editor.css',
  import.meta.url,
)), 'utf8');

describe('Tiptap image presentation', () => {
  it('paints an opaque-image selection inside the replaced element', () => {
    const selectedRule = /\.tiptap-editor-surface img\.ProseMirror-selectednode\s*\{([^}]*)\}/u
      .exec(CONTENT_EDITOR_CSS)?.[1] ?? '';
    expect(selectedRule).toContain('outline: 3px solid var(--studio-primary)');
    expect(selectedRule).toContain('outline-offset: -3px');
    expect(selectedRule).not.toContain('inset');
  });

  it('presents all three authored image alignments and a mobile float reset', () => {
    expect(CONTENT_EDITOR_CSS).toContain('img.alignleft');
    expect(CONTENT_EDITOR_CSS).toContain('img.aligncenter');
    expect(CONTENT_EDITOR_CSS).toContain('img.alignright');
    expect(CONTENT_EDITOR_CSS).toMatch(
      /@media \(max-width: 640px\)[\s\S]*img\.alignleft,[\s\S]*img\.alignright[\s\S]*float: none/u,
    );
  });
});
