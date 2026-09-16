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
  if (!rule) throw new Error(`Missing settings rule: ${selector}`);
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
    if (depth !== 0) throw new Error('Unclosed settings media query');
    blocks.push(CSS.slice(start, end - 1));
    offset = CSS.indexOf(marker, end);
  }
  return blocks.join('\n');
}

// Guard layout causes here; browser QA verifies the actual English/Korean
// labels, native controls, and editor geometry at breakpoint boundaries.
describe('responsive Site settings layout', () => {
  it('reserves a desktop rail while allowing the settings column to shrink', () => {
    expect(declarations(CSS, '.site-settings-layout'))
      .toContain('grid-template-columns: 232px minmax(0, 1fr)');
    expect(declarations(CSS, '.site-settings-picker')).toContain('display: none');
    expect(declarations(CSS, '.site-settings-content > .settings-form'))
      .toContain('grid-template-columns: minmax(0, 1fr)');
  });

  it('uses the same neutral selection surface as the other settings rail', () => {
    const active = declarations(CSS, '.site-settings-sections a.active');
    expect(active).toContain('background: var(--studio-surface)');
    expect(active).toContain('color: var(--studio-text)');
    expect(active).not.toContain('var(--studio-primary)');
  });

  it('replaces the rail with a compact selector at 1200px instead of scrolling eight links', () => {
    const compact = atWidth(1200);
    expect(declarations(compact, '.site-settings-layout'))
      .toContain('grid-template-columns: minmax(0, 1fr)');
    expect(declarations(compact, '.site-settings-picker')).toContain('display: block');
    expect(declarations(compact, '.site-settings-sections')).toContain('display: none');
  });

  it('stacks the selector and fields at 640px without squeezing button labels', () => {
    const mobile = atWidth(640);
    expect(declarations(mobile, '.site-settings-navigation'))
      .toContain('grid-template-columns: minmax(0, 1fr)');
    expect(declarations(mobile, '.settings-fields-split'))
      .toContain('grid-template-columns: minmax(0, 1fr)');
    expect(declarations(CSS, '.settings-actions-buttons')).toContain('flex-wrap: wrap');
    expect(declarations(mobile, '.settings-actions-buttons > .studio-button'))
      .toContain('flex: 1 1 auto');
    expect(declarations(CSS, '.site-settings-action-buttons')).not.toContain('grid-template-columns');
  });

  it('keeps branding slots and detected locale names within a narrow card', () => {
    expect(declarations(CSS, '.branding-slot-grid'))
      .toContain('minmax(min(100%, 200px), 1fr)');
    expect(declarations(CSS, '.settings-localization-detected'))
      .toContain('overflow-wrap: anywhere');
  });
});
