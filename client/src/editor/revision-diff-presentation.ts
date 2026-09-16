import type {
  ContentEditorMode,
  ContentEditorProfile,
} from '../../../contracts/content-editor';

export type RevisionDiffPresentationSource = {
  content: string;
  documentType: 'html' | 'markdown' | 'plaintext';
  editorMode: ContentEditorMode;
  editorProfile: ContentEditorProfile;
};

const VISUAL_BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'audio',
  'blockquote',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'iframe',
  'img',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
  'video',
]);

const VOID_TAGS = new Set([
  'hr',
  'img',
  'source',
  'track',
]);

function tagEnd(html: string, start: number): number {
  if (html.startsWith('<!--', start)) {
    const commentEnd = html.indexOf('-->', start + 4);
    return commentEnd === -1 ? -1 : commentEnd + 2;
  }

  let quote: '"' | "'" | null = null;
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') return index;
  }
  return -1;
}

function tagIdentity(token: string): {
  closing: boolean;
  name: string;
  selfClosing: boolean;
} | null {
  const match = token.match(/^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)/u);
  if (!match) return null;
  return {
    closing: match[1] === '/',
    name: match[2].toLowerCase(),
    selfClosing: /\/\s*>$/u.test(token),
  };
}

/**
 * Adds display-only logical lines at visual block boundaries without parsing
 * and reserializing authored HTML. Tag bytes, attributes, entities, and text
 * remain unchanged; the canonical content and revision hash never use this
 * projection.
 */
export function projectVisualHtmlForRevisionDiff(html: string): string {
  let output = '';
  let cursor = 0;

  const newline = () => {
    if (output.length > 0 && !output.endsWith('\n')) output += '\n';
  };
  const newlineAfterToken = (nextIndex: number) => {
    if (html[nextIndex] !== '\n' && html[nextIndex] !== '\r') newline();
  };

  while (cursor < html.length) {
    const start = html.indexOf('<', cursor);
    if (start === -1) {
      output += html.slice(cursor);
      break;
    }
    output += html.slice(cursor, start);
    const end = tagEnd(html, start);
    if (end === -1) {
      output += html.slice(start);
      break;
    }

    const token = html.slice(start, end + 1);
    const identity = tagIdentity(token);
    if (identity?.name === 'br' && !identity.closing) {
      output += token;
      newlineAfterToken(end + 1);
      cursor = end + 1;
      continue;
    }
    if (!identity || !VISUAL_BLOCK_TAGS.has(identity.name)) {
      output += token;
      cursor = end + 1;
      continue;
    }

    if (identity.closing) {
      output += token;
      newlineAfterToken(end + 1);
    } else {
      newline();
      output += token;
      if (identity.selfClosing || VOID_TAGS.has(identity.name)) {
        newlineAfterToken(end + 1);
      }
    }
    cursor = end + 1;
  }

  return output;
}

function isTiptapVisualHtml(source: RevisionDiffPresentationSource): boolean {
  return source.documentType === 'html'
    && source.editorMode === 'visual'
    && source.editorProfile === 'tiptap-v1';
}

/**
 * Use the block-aware projection only when both revisions share the reviewed
 * visual profile. Mixed visual/source comparisons stay byte-faithful so a
 * mode transition cannot appear as an artificial full-document rewrite.
 */
export function prepareRevisionDiffPresentation(input: {
  original: RevisionDiffPresentationSource;
  modified: RevisionDiffPresentationSource;
}): { original: string; modified: string } {
  if (!isTiptapVisualHtml(input.original) || !isTiptapVisualHtml(input.modified)) {
    return {
      original: input.original.content,
      modified: input.modified.content,
    };
  }
  return {
    original: projectVisualHtmlForRevisionDiff(input.original.content),
    modified: projectVisualHtmlForRevisionDiff(input.modified.content),
  };
}
