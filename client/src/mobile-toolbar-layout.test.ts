import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(
  fileURLToPath(new URL(`./screens/${name}.css`, import.meta.url)),
  'utf8',
);
const CONTENT_LIST = read('content-list');
const MEDIA = read('media');
const MEDIA_MARKUP = readFileSync(
  fileURLToPath(new URL('./MediaPage.tsx', import.meta.url)),
  'utf8',
);

function mobileRules(source: string): string {
  const start = source.indexOf('@media (max-width: 640px) {');
  if (start === -1) throw new Error('Missing mobile layout rules');
  const bodyStart = source.indexOf('{', start) + 1;
  let depth = 1;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(bodyStart, index);
  }
  throw new Error('Unclosed mobile layout rules');
}

function declarations(source: string, selector: string): string {
  const uncommented = source.replace(/\/\*[\s\S]*?\*\//gu, '');
  const rule = [...uncommented.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .find((match) => match[1].split(',').some((part) => part.trim() === selector));
  if (!rule) throw new Error(`Missing layout rule: ${selector}`);
  return rule[2];
}

// These assertions guard the layout causes, not rendered geometry. Narrow-screen
// browser QA must also check the actual labels, controls, and row positions.
describe('compact mobile list toolbars', () => {
  it('keeps search input and submit together instead of forcing every control onto a new row', () => {
    const mobile = mobileRules(CONTENT_LIST);
    expect(mobile).not.toMatch(/flex-direction:\s*column/u);
    expect(declarations(mobile, '.content-list-toolbar-editorial .content-list-search'))
      .toMatch(/flex-basis:\s*100%/u);
    expect(declarations(mobile, '.content-list-toolbar-editorial .content-list-search .studio-field'))
      .toMatch(/flex:\s*1\s+1\s+0/u);
  });

  it('lets filters share remaining space with the create action', () => {
    const mobile = mobileRules(CONTENT_LIST);
    expect(declarations(mobile, '.content-list-select-filter'))
      .toMatch(/min-width:\s*0/u);
    expect(declarations(mobile, '.content-list-select-filter'))
      .toMatch(/flex:\s*1\s+1\s+/u);
    expect(mobile).not.toMatch(/\.content-list-create-action[^{}]*\{[^}]*width:\s*100%/u);
  });

  it('keeps summary cards in multiple columns and allows narrow labels to wrap', () => {
    expect(declarations(CONTENT_LIST, '.content-list-metrics'))
      .toContain('repeat(3, minmax(0, 1fr))');
    const mobile = mobileRules(CONTENT_LIST);
    expect(declarations(mobile, '.content-list-metrics'))
      .not.toContain('grid-template-columns');
    expect(declarations(mobile, '.content-list-metrics dt'))
      .toContain('overflow-wrap: anywhere');
    expect(CONTENT_LIST).toMatch(
      /@media \(max-width: 900px\)\s*\{\s*\.content-list-metrics-four\s*\{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/u,
    );
  });

  it('wraps media actions by their label widths instead of squeezing them into fixed half-width columns', () => {
    expect(declarations(MEDIA, '.media-toolbar-actions')).toContain('display: flex');
    expect(declarations(MEDIA, '.media-toolbar-actions')).toContain('flex-wrap: wrap');
    const mobile = mobileRules(MEDIA);
    expect(declarations(mobile, '.media-toolbar-actions')).not.toContain('grid-template-columns');
    expect(declarations(mobile, '.media-toolbar-actions > *')).toContain('flex: 1 1 auto');
  });

  it('groups media search and submit before the two filters without changing visual or keyboard order', () => {
    const searchGroup = MEDIA_MARKUP.slice(
      MEDIA_MARKUP.indexOf('<div className="media-filter-search">'),
      MEDIA_MARKUP.indexOf('<div className="media-filter-kind">'),
    );
    expect(searchGroup).toContain('<Button type="submit">');
    expect(declarations(MEDIA, '.media-filter-search')).toContain('display: flex');
    expect(mobileRules(MEDIA)).not.toMatch(/\.media-list-filters\s*\{/u);
    expect(MEDIA).toMatch(
      /@media \(max-width: 900px\)\s*\{\s*\.media-list-filters\s*\{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/u,
    );
  });
});
