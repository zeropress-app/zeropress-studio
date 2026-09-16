import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(
  fileURLToPath(new URL('./shell.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//gu, '');

function declarations(selector: string): string {
  const rule = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter((match) => match[1].split(',').some((part) => part.trim() === selector))
    .at(-1);
  if (!rule) throw new Error(`Missing sidebar rule: ${selector}`);
  return rule[2];
}

describe('sidebar interaction states', () => {
  it('uses a white-derived hover and the clay active foreground', () => {
    const hover = declarations('.studio-sidebar-navigation a:hover');
    const active = declarations('.studio-sidebar-navigation a.active');

    expect(hover).toContain('var(--studio-sidebar-text) 5%');
    expect(active).toContain('background: var(--studio-sidebar-accent)');
    expect(active).toContain('color: var(--studio-sidebar-primary)');
    expect(active).toContain('var(--studio-sidebar-text) 15%');
  });

  it('keeps the navigation focus ring inside its scrolling boundary', () => {
    const focus = declarations('.studio-sidebar-navigation a:focus-visible');

    expect(focus).toContain('outline-offset: -3px');
  });
});
