const CLASSIC_BLOCK_TAGS = [
  'table', 'thead', 'tfoot', 'caption', 'col', 'colgroup', 'tbody', 'tr', 'td', 'th',
  'div', 'dl', 'dd', 'dt', 'ul', 'ol', 'li', 'pre', 'form', 'map', 'area',
  'blockquote', 'address', 'math', 'style', 'p', 'h[1-6]', 'hr', 'fieldset',
  'legend', 'section', 'article', 'aside', 'hgroup', 'header', 'footer', 'nav',
  'figure', 'figcaption', 'details', 'menu', 'summary',
];

const RAW_ELEMENT_PATTERN = /<(pre|script|style|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function privateToken(source: string, label: string): string {
  let token = `\uE000zeropress-wxr-${label}\uE001`;
  while (source.includes(token)) token = `${token}_`;
  return token;
}

function protectRawElements(source: string): {
  source: string;
  regions: Array<{ token: string; value: string }>;
  tagName: string;
} {
  const regions: Array<{ token: string; value: string }> = [];
  let tagName = 'zeropress-wxr-raw';
  while (new RegExp(`<${tagName}(?:[\\s>])`, 'iu').test(source)) {
    tagName = `${tagName}-x`;
  }
  return {
    source: source.replace(RAW_ELEMENT_PATTERN, (value) => {
      const token = `<${tagName} data-index="${regions.length}"></${tagName}>`;
      regions.push({ token, value });
      return `\n\n${token}\n\n`;
    }),
    regions,
    tagName,
  };
}

function tagEnd(source: string, start: number): number {
  if (source.startsWith('<!--', start)) {
    const end = source.indexOf('-->', start + 4);
    return end === -1 ? source.length - 1 : end + 2;
  }
  let quote: '"' | "'" | null = null;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return source.length - 1;
}

function protectTagNewlines(source: string, newlineToken: string): string {
  let output = '';
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor);
    if (start === -1) return output + source.slice(cursor);
    output += source.slice(cursor, start);
    const end = tagEnd(source, start);
    output += source.slice(start, end + 1).replaceAll('\n', newlineToken);
    cursor = end + 1;
  }
  return output;
}

function unwrapBlockParagraphs(source: string, blockPattern: string): string {
  let output = source.replace(/<p>\s*<\/p>/giu, '');
  output = output.replace(
    new RegExp(`<p>\\s*(<\\/?${blockPattern}[^>]*>)\\s*<\\/p>`, 'giu'),
    '$1',
  );
  output = output.replace(/<p>(<li\b[\s\S]*?)<\/p>/giu, '$1');
  output = output.replace(/<p><blockquote([^>]*)>/giu, '<blockquote$1><p>');
  output = output.replace(/<\/blockquote><\/p>/giu, '</p></blockquote>');
  output = output.replace(
    new RegExp(`<p>\\s*(<\\/?${blockPattern}[^>]*>)`, 'giu'),
    '$1',
  );
  return output.replace(
    new RegExp(`(<\\/?${blockPattern}[^>]*>)\\s*<\\/p>`, 'giu'),
    '$1',
  );
}

/**
 * Resolves classic WordPress paragraph and soft-break semantics before the
 * Tiptap compatibility classifier sees WXR HTML. Gutenberg block markup has
 * already declared its structure and bypasses this pass.
 */
export function materializeWordPressClassicHtml(value: string): string {
  let source = String(value ?? '').replace(/\r\n?|\u2028|\u2029/gu, '\n');
  if (source.trim() === '' || /<!--\s*\/?wp:/iu.test(source)) return source;

  const protectedRaw = protectRawElements(source);
  source = protectedRaw.source;
  const newlineToken = privateToken(source, 'tag-newline');
  const blockPattern = `(?:${[
    ...CLASSIC_BLOCK_TAGS,
    escapeRegExp(protectedRaw.tagName),
  ].join('|')})`;

  source += '\n';
  source = source.replace(/<br\s*\/?>\s*<br\s*\/?>/giu, '\n\n');
  source = source.replace(
    new RegExp(`(<${blockPattern}[\\s/>])`, 'giu'),
    '\n\n$1',
  );
  source = source.replace(
    new RegExp(`(<\\/${blockPattern}>)`, 'giu'),
    '$1\n\n',
  );
  source = protectTagNewlines(source, newlineToken);

  source = source
    .replace(/\s*<option/giu, '<option')
    .replace(/<\/option>\s*/giu, '</option>')
    .replace(/(<object\b[^>]*>)\s*/giu, '$1')
    .replace(/\s*<\/object>/giu, '</object>')
    .replace(/\s*(<\/?(?:param|embed)\b[^>]*>)\s*/giu, '$1')
    .replace(/(<(?:audio|video)\b[^>]*>)\s*/giu, '$1')
    .replace(/\s*(<\/(?:audio|video)>)/giu, '$1')
    .replace(/\s*(<(?:source|track)\b[^>]*>)\s*/giu, '$1')
    .replace(/\s*(<figcaption\b[^>]*>)/giu, '$1')
    .replace(/<\/figcaption>\s*/giu, '</figcaption>')
    .replace(/\n\n+/gu, '\n\n');

  source = source
    .split(/\n[\t ]*\n/gu)
    .filter((part) => part !== '')
    .map((part) => `<p>${part.replace(/^\n+|\n+$/gu, '')}</p>\n`)
    .join('');
  source = source.replace(
    /<p>([^<]+)<\/(div|address|form)>/giu,
    '<p>$1</p></$2>',
  );
  source = unwrapBlockParagraphs(source, blockPattern);

  source = source.replace(/<br\s*\/?>/giu, '<br />');
  source = source.replace(/(<br \/>[\t ]*)?[\t ]*\n/gu, (_match, existingBreak) => (
    existingBreak ? `${String(existingBreak).trimEnd()}\n` : '<br />\n'
  ));
  source = source.replace(
    new RegExp(`(<\\/?${blockPattern}[^>]*>)\\s*<br \/>`, 'giu'),
    '$1',
  );
  source = source.replace(
    /<br \/>(\s*<\/?(?:p|li|div|dl|dd|dt|th|pre|td|ul|ol)\b[^>]*>)/giu,
    '$1',
  );
  source = source.replace(/\n<\/p>$/u, '</p>');
  source = source.replace(/\n{2,}/gu, '\n');
  source = source.replaceAll(newlineToken, '\n');
  for (const region of protectedRaw.regions) {
    source = source.replace(region.token, () => region.value);
  }
  return source.replace(/\n+$/u, '');
}
