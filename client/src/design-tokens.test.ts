import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  describe,
  expect,
  it,
} from 'vitest';

/**
 * Studio design-token contract.
 *
 * Validate actual styles.css declarations so token regressions are detected. Register usage pairs
 * in CONTRAST whenever adding a color token.
 */

const read = (name: string) => readFileSync(
  fileURLToPath(new URL(`./${name}`, import.meta.url)),
  'utf8',
);

const SOURCE = read('styles.css');
/**
 * Stylesheets governed by the full token policy.
 *
 * Screen sheets live under screens/. styles.css owns the token definitions and is excluded from
 * the raw-value ban.
 */
const TOKENIZED_SHEETS = [
  'primitives.css',
  'shell.css',
  'screens/dashboard.css',
  'screens/content-list.css',
  'screens/content-editor.css',
  'screens/content-dialogs.css',
  'screens/comments.css',
  'screens/newsletters.css',
  'screens/forms.css',
  'screens/settings.css',
  'screens/media.css',
  'screens/structure.css',
  'screens/navigation.css',
  'screens/preview-data.css',
  'screens/wxr.css',
  'screens/users.css',
  'screens/account-security.css',
  'screens/auth.css',
  'screens/auth-setup.css',
  'screens/operations.css',
] as const;
const PRIMITIVES = TOKENIZED_SHEETS.map(read).join('\n');

/**
 * Ignore comments when inspecting CSS rules. Within @font-face, font-weight: 400 700 declares
 * a variable font's supported range and is excluded from screen-style scale checks.
 */
const STYLES = `${SOURCE}\n${PRIMITIVES}`
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .replace(/@font-face\s*\{[^}]*\}/gu, '');

/** Extract the declaration block for one selector. */
function blockOf(selector: string): string {
  const start = STYLES.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`${selector} block not found`);
  return STYLES.slice(start, STYLES.indexOf('\n}', start));
}

const ROOT_BLOCK = blockOf(':root');
const DARK_BLOCK = blockOf("[data-theme='dark']");

type Oklch = [number, number, number];

function parseOklchTokens(block: string): Map<string, Oklch> {
  const tokens = new Map<string, Oklch>();
  const pattern =
    /--(studio-[a-z0-9-]+):\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/gu;
  for (const match of block.matchAll(pattern)) {
    tokens.set(match[1], [
      Number(match[2]),
      Number(match[3]),
      Number(match[4]),
    ]);
  }
  return tokens;
}

const TOKENS = parseOklchTokens(ROOT_BLOCK);
const DARK_OVERRIDES = parseOklchTokens(DARK_BLOCK);

/**
 * Effective palette for each theme.
 *
 * Dark mode inherits :root values for tokens it does not override. Contrast checks must account
 * for that inheritance.
 */
const PALETTES: ReadonlyArray<readonly [string, Map<string, Oklch>]> = [
  ['light', TOKENS],
  ['dark', new Map([...TOKENS, ...DARK_OVERRIDES])],
];

function oklchToSrgb(
  lightness: number,
  chroma: number,
  hueDegrees: number,
): [number, number, number] {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const lCbrt = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mCbrt = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sCbrt = lightness - 0.0894841775 * a - 1.2914855480 * b;
  const l = lCbrt ** 3;
  const m = mCbrt ** 3;
  const s = sCbrt ** 3;
  const encode = (channel: number) => (channel <= 0.0031308
    ? 12.92 * channel
    : 1.055 * channel ** (1 / 2.4) - 0.055);
  return [
    encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    encode(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ];
}

function srgbOf(
  token: string,
  palette: Map<string, Oklch> = TOKENS,
): [number, number, number] {
  const value = palette.get(token);
  if (!value) throw new Error(`Token --${token} not found`);
  return oklchToSrgb(...value);
}

function relativeLuminance(rgb: readonly number[]): number {
  const [r, g, b] = rgb.map((channel) => {
    const c = Math.min(1, Math.max(0, channel));
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(
  a: string,
  b: string,
  palette: Map<string, Oklch> = TOKENS,
): number {
  const x = relativeLuminance(srgbOf(a, palette));
  const y = relativeLuminance(srgbOf(b, palette));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** WCAG 2.2 AA: 4.5:1 for body text (1.4.3), 3:1 for UI controls and status indicators (1.4.11). */
const TEXT_MINIMUM = 4.5;
const NON_TEXT_MINIMUM = 3;

const LOGO_FACES = [
  'studio-logo-top',
  'studio-logo-left',
  'studio-logo-right',
  'studio-logo-bottom-left',
  'studio-logo-bottom-right',
] as const;

const logoContrast = (surface: string): [string, string, string, number][] => (
  LOGO_FACES.map((face) => ([
    `LogoMark ${face.replace('studio-logo-', '')} / ${surface}`,
    face,
    surface,
    NON_TEXT_MINIMUM,
  ]))
);

const CONTRAST: readonly [string, string, string, number][] = [
  ['body text / card', 'studio-text', 'studio-surface', TEXT_MINIMUM],
  ['body text / page background', 'studio-text', 'studio-background', TEXT_MINIMUM],
  ['body text / muted surface', 'studio-text', 'studio-surface-subtle', TEXT_MINIMUM],
  ['muted text / card', 'studio-text-muted', 'studio-surface', TEXT_MINIMUM],
  ['muted text / page background', 'studio-text-muted', 'studio-background', TEXT_MINIMUM],
  ['muted text / muted surface', 'studio-text-muted', 'studio-surface-subtle', TEXT_MINIMUM],
  /*
   * Supporting text and body text also appear on status surfaces. Include these combinations; a
   * Preview Data validation description previously reached only 4.47:1 on the success surface.
   */
  ['body text / primary surface', 'studio-text', 'studio-primary-surface', TEXT_MINIMUM],
  ['body text / success surface', 'studio-text', 'studio-success-surface', TEXT_MINIMUM],
  ['body text / warning surface', 'studio-text', 'studio-warning-surface', TEXT_MINIMUM],
  ['body text / danger surface', 'studio-text', 'studio-danger-surface', TEXT_MINIMUM],
  ['muted text / primary surface', 'studio-text-muted', 'studio-primary-surface', TEXT_MINIMUM],
  ['muted text / success surface', 'studio-text-muted', 'studio-success-surface', TEXT_MINIMUM],
  ['muted text / warning surface', 'studio-text-muted', 'studio-warning-surface', TEXT_MINIMUM],
  ['muted text / danger surface', 'studio-text-muted', 'studio-danger-surface', TEXT_MINIMUM],
  ['primary / card', 'studio-primary', 'studio-surface', TEXT_MINIMUM],
  ['primary / primary surface', 'studio-primary', 'studio-primary-surface', TEXT_MINIMUM],
  ['foreground / primary', 'studio-primary-foreground', 'studio-primary', TEXT_MINIMUM],
  ['foreground / primary-hover', 'studio-on-solid', 'studio-primary-hover', TEXT_MINIMUM],
  ['foreground / danger-hover', 'studio-on-solid', 'studio-danger-hover', TEXT_MINIMUM],
  ['success / success surface', 'studio-success', 'studio-success-surface', TEXT_MINIMUM],
  ['success / card', 'studio-success', 'studio-surface', TEXT_MINIMUM],
  ['warning / warning surface', 'studio-warning', 'studio-warning-surface', TEXT_MINIMUM],
  ['warning / card', 'studio-warning', 'studio-surface', TEXT_MINIMUM],
  ['danger / danger surface', 'studio-danger', 'studio-danger-surface', TEXT_MINIMUM],
  ['danger / card', 'studio-danger', 'studio-surface', TEXT_MINIMUM],
  ['control border / card', 'studio-border-strong', 'studio-surface', NON_TEXT_MINIMUM],
  ['control border / page background', 'studio-border-strong', 'studio-background', NON_TEXT_MINIMUM],
  // Field-editing cards and filter rows place controls on subtle surfaces.
  ['control border / muted surface', 'studio-border-strong', 'studio-surface-subtle', NON_TEXT_MINIMUM],
  ['hovered control border / card', 'studio-border-strong-hover', 'studio-surface', NON_TEXT_MINIMUM],
  /*
   * Focus rings convey state and require 3:1 contrast (1.4.11, 2.4.13). Include translucent tokens
   * and every surface behind an inner or outer ring, including status backgrounds. A missing check
   * previously allowed a nearly invisible 1.24:1 ring.
   */
  ['focus ring / card', 'studio-focus', 'studio-surface', NON_TEXT_MINIMUM],
  ['focus ring / page background', 'studio-focus', 'studio-background', NON_TEXT_MINIMUM],
  ['focus ring / muted surface', 'studio-focus', 'studio-surface-subtle', NON_TEXT_MINIMUM],
  ['focus ring / primary surface', 'studio-focus', 'studio-primary-surface', NON_TEXT_MINIMUM],
  ['focus ring / success surface', 'studio-focus', 'studio-success-surface', NON_TEXT_MINIMUM],
  ['focus ring / warning surface', 'studio-focus', 'studio-warning-surface', NON_TEXT_MINIMUM],
  ['focus ring / danger surface', 'studio-focus', 'studio-danger-surface', NON_TEXT_MINIMUM],
  // Ink surfaces rebind the ring to -on-ink and remain dark in both themes.
  ['on-ink focus ring / sidebar', 'studio-focus-on-ink', 'studio-sidebar', NON_TEXT_MINIMUM],
  ['on-ink focus ring / active sidebar surface', 'studio-focus-on-ink', 'studio-sidebar-accent', NON_TEXT_MINIMUM],
  ['focus border / card', 'studio-primary', 'studio-surface', NON_TEXT_MINIMUM],
  ['error border / card', 'studio-danger', 'studio-surface', NON_TEXT_MINIMUM],
  ['sidebar body text', 'studio-sidebar-text', 'studio-sidebar', TEXT_MINIMUM],
  ['sidebar muted text', 'studio-sidebar-text-muted', 'studio-sidebar', TEXT_MINIMUM],
  ['sidebar primary', 'studio-sidebar-primary', 'studio-sidebar', TEXT_MINIMUM],
  ['body text / active sidebar surface', 'studio-sidebar-text', 'studio-sidebar-accent', TEXT_MINIMUM],
  ['active sidebar link', 'studio-sidebar-primary', 'studio-sidebar-accent', TEXT_MINIMUM],
  ['sidebar muted text / active surface', 'studio-sidebar-text-muted', 'studio-sidebar-accent', TEXT_MINIMUM],
  ['skip link', 'studio-sidebar-text', 'studio-sidebar', TEXT_MINIMUM],
  // The pre-authentication brand panel shares the sidebar's dark ink surface.
  ['structural accent / ink surface', 'studio-signal', 'studio-sidebar', TEXT_MINIMUM],
  // LogoMark always appears on the shared ink badge, regardless of theme.
  ...logoContrast('studio-sidebar-accent'),
];

/**
 * Check the same combinations in both palettes so changing one theme cannot silently lower
 * contrast in the other.
 */
const THEMED_CONTRAST = PALETTES.flatMap(([theme, palette]) => CONTRAST
  .map(([label, foreground, background, minimum]) => ({
    theme,
    palette,
    label,
    foreground,
    background,
    minimum,
  })));

describe('Design token contrast', () => {
  it.each(THEMED_CONTRAST)(
    '[$theme] $label meets the contrast requirement for $foreground/$background',
    ({ palette, foreground, background, minimum }) => {
      expect(contrastRatio(foreground, background, palette))
        .toBeGreaterThanOrEqual(minimum);
    },
  );
});

describe('Design token contract', () => {
  it.each(PALETTES)('[%s] keeps every color token within the sRGB gamut', (
    _theme,
    palette,
  ) => {
    const outOfGamut = [...palette.keys()]
      .filter((token) => srgbOf(token, palette)
        .some((channel) => channel < -0.001 || channel > 1.001));
    expect(outOfGamut).toEqual([]);
  });

  it('declares color tokens only in oklch', () => {
    const nonOklch = [...`${ROOT_BLOCK}\n${DARK_BLOCK}`.matchAll(
      /--studio-[a-z0-9-]+:\s*(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/gu,
    )].map((match) => match[0]);
    expect(nonOklch).toEqual([]);
  });

  it('keeps theme rules within styles.css', () => {
    // Screens and primitives remain theme-independent. A sheet-specific dark branch
    // would stop following changes to the shared palette.
    const offenders = TOKENIZED_SHEETS.filter((name) => {
      const sheet = read(name).replace(/\/\*[\s\S]*?\*\//gu, '');
      return sheet.includes('prefers-color-scheme')
        || sheet.includes('[data-theme');
    });
    expect(offenders).toEqual([]);
  });

  it('overrides only colors in the dark theme', () => {
    // Radii, page widths, font weights, and typefaces are theme-independent geometry.
    // Changing them here would shift layout when switching themes.
    const geometry = [...DARK_BLOCK.matchAll(/--studio-[a-z0-9-]+/gu)]
      .map((match) => match[0])
      .filter((token) => /^--studio-(?:radius|page|weight|font)-/u.test(token));
    expect(geometry).toEqual([]);
  });

  it('updates color-scheme for the dark theme', () => {
    // Without this, native selects, scrollbars, and form controls would remain light.
    expect(DARK_BLOCK).toMatch(/color-scheme:\s*dark/u);
  });

  it('leaves only intentional color tokens without dark-theme overrides', () => {
    /*
     * Explicitly list tokens allowed to inherit the light palette. Accidentally omitting a dark
     * override can lose contrast on combinations not covered by the contrast table.
     */
    const SHARED = new Set([
      // Focus ring used only on ink surfaces, which are dark in both themes.
      'studio-focus-on-ink',
      // LogoMark uses the shared ink badge in both themes.
      ...LOGO_FACES,
    ]);
    const inherited = [...TOKENS.keys()]
      .filter((token) => !DARK_OVERRIDES.has(token) && !SHARED.has(token));
    expect(inherited).toEqual([]);
  });

  it('uses tokens instead of raw colors in primitive CSS', () => {
    // Primitives and screen CSS both follow the same design-token contract.
    const raw = [...PRIMITIVES.matchAll(
      /(#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|(?<!var\(-{2}[\w-]{0,64})\boklch\()/gu,
    )].map((match) => match[0]);
    expect(raw).toEqual([]);
  });

  it('avoids unscoped inline-element selectors that override primitives', () => {
    // Primitives can render inline elements, such as span for StatusPill and strong for Notice titles.
    // Screen rules like .wrapper > span { color: ... } can have higher specificity
    // and override primitive presentation.
    // Exclude structural properties such as display, gap, and padding, and fixed
    // HTML structures such as dt/dd/th/td.
    const INLINE = /(?:^|[\s>+~])(?:span|strong|em|small|b|i)(?::[a-z-]+(?:\([^)]*\))?)*\s*$/u;
    const PRESENTATIONAL =
      /(?:^|;)\s*(?:color|background|background-color|border-radius|font-weight)\s*:/u;
    const offenders: string[] = [];
    for (const [, selector, block] of PRIMITIVES
      .matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      if (!PRESENTATIONAL.test(block)) continue;
      for (const part of selector.split(',')) {
        const compound = part.trim().replace(/\/\*[\s\S]*?\*\//gu, '').trim();
        if (compound.length > 0 && INLINE.test(compound)) {
          offenders.push(compound.replace(/\s+/gu, ' '));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('uses only the standard breakpoints in primitive CSS', () => {
    const allowed = new Set(['640px', '900px', '1200px']);
    const used = [...PRIMITIVES.matchAll(/@media[^{]*?(\d+px)/gu)]
      .map((match) => match[1])
      .filter((value) => !allowed.has(value));
    expect(used).toEqual([]);
  });

  it('resets desktop column widths and cell dividers in card tables', () => {
    const mobile = read('primitives.css').match(
      /@media \(max-width: 640px\) \{([\s\S]*?\n\})/u,
    )?.[1];
    expect(mobile).toBeDefined();
    expect(mobile).toMatch(/\.studio-table-stacked colgroup\s*\{\s*display: none;/u);
    expect(mobile).toMatch(
      /\.studio-table-scroll-framed \.studio-table-stacked tbody tr\s*\{\s*padding: 14px 16px;/u,
    );
    expect(mobile).toMatch(
      /\.studio-table-stacked tbody tr \+ tr td\s*\{[^}]*border-top: 0;/u,
    );
  });

  it('groups titles and actions in mobile compact tables with two-column supporting details', () => {
    const mobile = PRIMITIVES.match(
      /@media \(max-width: 640px\) \{([\s\S]*?\n\})/u,
    )?.[1] ?? '';
    expect(mobile).toMatch(
      /\.studio-table-stacked-compact tbody tr\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[^}]*padding: 14px 16px;/u,
    );
    expect(mobile).toMatch(
      /\.studio-table-stacked-compact tbody tr > td\s*\{[^}]*min-width: 0;[^}]*width: auto;/u,
    );
    for (const role of ['primary', 'select', 'actions']) {
      expect(mobile).toContain(`[data-stack="${role}"]`);
    }
    for (const role of ['select', 'actions']) {
      const rule = mobile.split(`td[data-stack="${role}"] {`)[1]?.split('}')[0];
      expect(rule).toContain('z-index: 1;');
    }
    expect(mobile).toMatch(/td\[data-stack="wide"\]\s*\{\s*grid-column: 1 \/ -1;/u);
    expect(mobile).toContain('[data-stack-detail="secondary"]');
  });

  it('loads fonts only from self-hosted assets', () => {
    const remote = [...SOURCE.matchAll(/@font-face\s*\{[^}]*\}/gu)]
      .flatMap((block) => [...block[0].matchAll(/url\(\s*["']?([^"')]+)/gu)])
      .map((match) => match[1])
      .filter((href) => !href.startsWith('/'));
    expect(remote).toEqual([]);
  });

  it('matches the declared font asset to its recorded hash', () => {
    const declared = [...SOURCE.matchAll(/sha256\s+([0-9a-f]{64})/gu)]
      .map((match) => match[1]);
    expect(declared).toHaveLength(1);

    const asset = readFileSync(fileURLToPath(
      new URL('../public/fonts/PretendardVariable.woff2', import.meta.url),
    ));
    expect(asset.subarray(0, 4).toString('latin1')).toBe('wOF2');
    expect(createHash('sha256').update(asset).digest('hex'))
      .toBe(declared[0]);
  });

  it('leaves spinner spacing to the container', () => {
    // The previous spinner's 28px bottom margin displaced it 14px above text
    // in horizontally centered flex layouts.
    // The container's gap owns spacing between the spinner and text.
    const offenders = [...PRIMITIVES.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .filter(([, selector, block]) => /\.studio-spinner/u.test(selector)
        && /(?:^|;)\s*margin/u.test(block))
      .map(([, selector]) => selector.trim());
    expect(offenders).toEqual([]);
  });

  it('uses solid-surface foreground colors only on filled surfaces', () => {
    /*
     * --studio-on-solid and --studio-primary-foreground are foregrounds for primary, danger, and
     * success fills. They are white in light mode but switch to ink on light fills in dark mode,
     * so they cannot mean generic white text on an ink panel. The login brand title previously
     * fell to 1.07:1 contrast this way.
     *
     * Rules using these tokens must also declare the matching filled background. Use
     * --studio-sidebar-text on ink surfaces.
     */
    const FOREGROUND = /color:[^;]*var\(--studio-(?:on-solid|primary-foreground)\)/u;
    const SOLID_FILL =
      /background(?:-color)?:[^;]*var\(--studio-(?:primary|danger|success|warning)\)/u;
    const offenders = [...PRIMITIVES
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .filter(([, , body]) => FOREGROUND.test(body) && !SOLID_FILL.test(body))
      .map(([, selector]) => selector.trim().replace(/\s+/gu, ' '));
    expect(offenders).toEqual([]);
  });

  it('redirects the focus token on dark ink surfaces', () => {
    /*
     * The default focus ring targets page surfaces and may lack contrast on ink surfaces (2.73:1
     * against a code header in light mode). Ink surfaces must rebind --studio-focus to -on-ink,
     * while controls always read --studio-focus.
     *
     * Check new ink surfaces so their controls cannot silently inherit an invisible ring.
     */
    // Inspect ink base surfaces only. Accent and border colors belong inside
    // ancestors that already provide the override.
    const INK = /background:[^;]*var\(--studio-(?:sidebar\)|code-surface)/u;
    /**
     * Ink surfaces that need no override.
     *
     * They either contain no focusable elements or place the ring outside the surface. The
     * background color alone does not determine where the ring appears.
     */
    const NOT_INK_RING = new Set([
      // Pre-authentication brand panel: text and decoration only; controls are in the light form panel.
      '.auth-brand',
      // Logo-preview box simulating a dark public-site area; contains only an image.
      '.branding-preview-dark',
      // Floating pill whose ring appears outside it on the page background.
      '.studio-skip-link',
    ]);

    const rules = [...PRIMITIVES
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .map(([, selector, body]) => ({
        selector: selector.trim().replace(/\s+/gu, ' '),
        body,
      }));

    // Classes that override the focus token; descendants inherit that override.
    const repointed = rules
      .filter(({ body }) => /--studio-focus:/u.test(body))
      .flatMap(({ selector }) => selector.match(/\.[a-z][\w-]*/gu) ?? []);

    const offenders = rules
      .filter(({ selector, body }) => INK.test(body)
        && !/--studio-focus:/u.test(body)
        && !repointed.some((name) => selector.includes(name))
        && !NOT_INK_RING.has(selector))
      .map(({ selector }) => selector);
    expect(offenders).toEqual([]);
  });

  it('gives explicitly sized primitives a non-inline display mode', () => {
    /*
     * Width and height do not size non-replaced inline elements. A span-based primitive without
     * display may appear correct only inside flex layout, where items become blockified. Elsewhere
     * it can collapse, as when a 46px spinner rendered as a 3px fragment.
     *
     * Replaced elements such as SVG support inline sizing, and absolute positioning also
     * establishes a sized box.
     */
    const REPLACED = /\b(?:svg|img|canvas|video|input|select|textarea|button)\b/u;
    /**
     * Classes used only on tags with an appropriate default display, such as table for
     * .studio-table.
     */
    const TAG_IS_BOX = new Set(['.studio-table']);
    const rules = [...PRIMITIVES
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .map(([, selector, body]) => ({
        selector: selector.trim().replace(/\s+/gu, ' '),
        body,
      }));

    // Collect display and position declarations for each class.
    const declared = new Map<string, { display?: string; position?: string }>();
    for (const { selector, body } of rules) {
      const display = body.match(/(?:^|;)\s*display:\s*([a-z-]+)/u)?.[1];
      const position = body.match(/(?:^|;)\s*position:\s*([a-z-]+)/u)?.[1];
      if (!display && !position) continue;
      for (const name of selector.match(/\.studio-[a-z0-9-]+/gu) ?? []) {
        const entry = declared.get(name) ?? {};
        declared.set(name, {
          display: display ?? entry.display,
          position: position ?? entry.position,
        });
      }
    }
    // .studio-spinner defines the box for .studio-spinner-lg.
    const resolve = (name: string) => [...declared.entries()]
      .filter(([key]) => name === key || name.startsWith(`${key}-`))
      .map(([, value]) => value);

    const offenders = rules
      .filter(({ selector, body }) => {
        if (!/(?:^|;)\s*(?:width|height):\s*[\d.]/u.test(body)) return false;
        if (REPLACED.test(selector)) return false;
        const names = selector.match(/\.studio-[a-z0-9-]+/gu) ?? [];
        if (names.length === 0) return false;
        if (names.some((name) => TAG_IS_BOX.has(name))) return false;
        return names.every((name) => resolve(name).every((value) => (
          (!value.display || value.display === 'inline')
          && value.position !== 'absolute'
          && value.position !== 'fixed'
        )));
      })
      .map(({ selector }) => selector);
    expect(offenders).toEqual([]);
  });

  it('respects reduced motion for spinner rotation', () => {
    const reduced = PRIMITIVES.match(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?\n\})/u,
    );
    expect(reduced).not.toBeNull();
    expect(reduced?.[1]).toMatch(/\.studio-spinner\b/u);
    expect(reduced?.[1]).toMatch(/animation:\s*none/u);
  });

  it('references only defined Studio tokens', () => {
    const scale = new Set([
      ...TOKENS.keys(),
      ...[...ROOT_BLOCK.matchAll(/--(studio-[a-z0-9-]+):/gu)]
        .map((match) => match[1]),
    ]);
    const referenced = new Set(
      [...STYLES.matchAll(/var\(\s*--(studio-[a-z0-9-]+)\s*[,)]/gu)]
        .map((match) => match[1]),
    );
    expect([...referenced].filter((token) => !scale.has(token))).toEqual([]);
  });

  it('uses Studio token references without fallback values', () => {
    const withFallback = [...STYLES.matchAll(
      /var\(\s*--studio-[a-z0-9-]+\s*,[^)]*\)/gu,
    )].map((match) => match[0]);
    expect(withFallback).toEqual([]);
  });

  it('uses control-border tokens rather than decorative borders on inputs', () => {
    // --studio-border does not meet the 3:1 requirement of 1.4.11 and is only for separators.
    const control = /\b(?:input|select|textarea)\b/iu;
    const decorativeBorder =
      /border(?:-(?:top|right|bottom|left))?(?:-color)?:\s*[^;]*var\(--studio-border\)/u;
    const offenders = [...STYLES.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .filter(([, selector, block]) => control.test(selector)
        && decorativeBorder.test(block))
      .map(([, selector]) => selector.trim().replace(/\s+/gu, ' '));
    expect(offenders).toEqual([]);
  });

  it('uses tokens rather than hardcoded control-border colors', () => {
    const control = /\b(?:input|select|textarea)\b/iu;
    const hardcoded =
      /border(?:-(?:top|right|bottom|left))?(?:-color)?:\s*[^;]*#[0-9a-fA-F]{3,8}/u;
    const offenders = [...STYLES.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .filter(([, selector, block]) => control.test(selector)
        && hardcoded.test(block))
      .map(([, selector]) => selector.trim().replace(/\s+/gu, ' '));
    expect(offenders).toEqual([]);
  });

  it('uses only the four font-weight tokens', () => {
    const raw = [...STYLES.matchAll(/font-weight:\s*([^;}]+)/gu)]
      .map((match) => match[1].trim())
      .filter((value) => !/^var\(--studio-weight-[a-z]+\)$/u.test(value))
      .filter((value) => !['inherit', 'normal', 'bold'].includes(value));
    expect(raw).toEqual([]);
  });

  it('uses only radius-scale tokens for border-radius', () => {
    const raw = [...STYLES.matchAll(/border-radius:\s*([^;}]+)/gu)]
      .map((match) => match[1].trim())
      .filter((value) => value !== 'inherit')
      .filter((value) => !/^(?:var\(--studio-radius-[a-z0-9]+\)|0|50%|\s)+$/u
        .test(value));
    expect(raw).toEqual([]);
  });
});
