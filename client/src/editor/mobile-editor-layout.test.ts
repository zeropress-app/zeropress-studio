import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const css = read('../screens/content-editor.css');

describe('Mobile editor layout boundaries', () => {
  it('allows long authored content to shrink inside the visual editor Grid', () => {
    expect(css).toMatch(
      /\.content-body-editor,\s*\.studio-visual-editor\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/u,
    );
    expect(css).toMatch(/\.studio-visual-editor-content\s*\{[^}]*min-width:\s*0/u);
    expect(css).toMatch(
      /\.studio-visual-editor-content \.studio-visual-editor-surface\s*\{[^}]*overflow-wrap:\s*anywhere/u,
    );
    expect(read('../components/SunEditorVisualEditor.tsx')).toContain(
      '<div className="studio-visual-editor-content" ref={hostRef} />',
    );
  });

  it('keeps the stable scrollbar gutter without forcing a 320px-wide body', () => {
    const reset = read('../styles.css');
    expect(reset).toMatch(/html\s*\{[^}]*scrollbar-gutter:\s*stable/u);
    const body = /\nbody\s*\{([^}]*)\}/u.exec(reset)?.[1] ?? '';
    expect(body).toContain('min-width: 0');
    expect(body).not.toMatch(/min-width:\s*320px/u);
  });
});
