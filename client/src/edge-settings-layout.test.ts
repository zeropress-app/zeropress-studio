import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(
  fileURLToPath(new URL('./screens/settings.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//gu, '');

function declarations(source: string, selector: string): string {
  const rule = [...source.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .find((match) => match[1].split(',').some((part) => part.trim() === selector));
  if (!rule) throw new Error(`Missing Edge settings rule: ${selector}`);
  return rule[2];
}

function atWidth(width: number): string {
  const marker = `@media (max-width: ${width}px)`;
  const blocks: string[] = [];
  let offset = CSS.indexOf(marker);
  while (offset !== -1) {
    const start = CSS.indexOf('{', offset) + 1;
    let depth = 1;
    let end = start;
    while (depth > 0 && end < CSS.length) {
      if (CSS[end] === '{') depth += 1;
      if (CSS[end] === '}') depth -= 1;
      end += 1;
    }
    if (depth !== 0) throw new Error('Unclosed Edge settings media query');
    blocks.push(CSS.slice(start, end - 1));
    offset = CSS.indexOf(marker, end);
  }
  return blocks.join('\n');
}

describe('responsive Edge settings layout', () => {
  it('owns a desktop rail independently from Site settings', () => {
    expect(declarations(CSS, '.edge-settings-layout'))
      .toContain('grid-template-columns: 232px minmax(0, 1fr)');
    expect(declarations(CSS, '.edge-settings-picker')).toContain('display: none');
    expect(declarations(CSS, '.edge-settings-content > .settings-form'))
      .toContain('grid-template-columns: minmax(0, 1fr)');
  });

  it('uses neutral navigation selection and structured status facts', () => {
    const active = declarations(CSS, '.edge-settings-sections a.active');
    expect(active).toContain('background: var(--studio-surface)');
    expect(active).toContain('color: var(--studio-text)');
    expect(active).not.toContain('var(--studio-primary)');
    expect(declarations(CSS, '.edge-settings-status-facts'))
      .toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
  });

  it('uses a native selector at 1200px instead of a horizontal link strip', () => {
    const compact = atWidth(1200);
    expect(declarations(compact, '.edge-settings-layout'))
      .toContain('grid-template-columns: minmax(0, 1fr)');
    expect(declarations(compact, '.edge-settings-picker')).toContain('display: block');
    expect(declarations(compact, '.edge-settings-sections')).toContain('display: none');
  });

  it('stacks its selector and Operations link at 640px', () => {
    const mobile = atWidth(640);
    expect(declarations(mobile, '.edge-settings-navigation'))
      .toContain('grid-template-columns: minmax(0, 1fr)');
    expect(declarations(mobile, '.edge-settings-operations'))
      .toContain('justify-self: end');
    expect(declarations(mobile, '.edge-settings-status-facts'))
      .toContain('grid-template-columns: minmax(0, 1fr)');
  });
});
