import suneditor from 'suneditor';
import {
  align, blockStyle, blockquote, codeBlock, fontColor, hr, link,
  list_bulleted, list_numbered, table, textStyle,
} from 'suneditor/plugins';
import en from 'suneditor/langs/en';
import ko from 'suneditor/langs/ko';

// Public themes own table layout. Keep structural editing, without controls
// whose inline presentation would be discarded by the public HTML contract.
const unsupportedTableCommands = new Set([
  'openTableProperties', 'openCellProperties', 'layout', 'caption', 'resize',
]);
class StudioTable extends table {
  constructor(...args: ConstructorParameters<typeof table>) {
    super(...args);
    for (const controller of [this.controller_table, this.controller_cell]) {
      controller.form.querySelectorAll<HTMLButtonElement>('button[data-command]').forEach((button) => {
        if (unsupportedTableCommands.has(button.dataset.command ?? '')) {
          button.disabled = true;
          button.style.display = 'none';
        }
      });
    }
    this.resizeService.onResizeGuide = () => undefined;
    this.resizeService.readyResizeFromEdge = () => undefined;
  }

  override controllerAction(target: HTMLButtonElement) {
    if (!unsupportedTableCommands.has(target.dataset.command ?? '')) super.controllerAction(target);
  }
}

// Studio owns uploads and media selection. Do not enable SunEditor's independent
// upload, base64 image, preview, or source-editing paths.
export function sunEditorOptions(language = 'en'): SunEditor.InitOptions {
  return {
    plugins: [align, blockStyle, blockquote, codeBlock, fontColor, hr, link,
      list_bulleted, list_numbered, StudioTable, textStyle],
    lang: language.startsWith('ko') ? ko : en,
    buttonList: [
      ['undo', 'redo'], ['blockStyle'],
      ['bold', 'italic', 'underline', 'strike', 'subscript', 'superscript'],
      ['textStyle', 'fontColor', 'removeFormat'],
      ['align', 'list_bulleted', 'list_numbered', 'blockquote', 'codeBlock', 'hr'],
      ['link', 'table'],
    ],
    width: '100%', minHeight: '360px', height: 'auto',
    toolbar_sticky: -1,
    textStyle: { items: ['code'] },
    __listCommonStyle: [],
    strictMode: {
      tagFilter: true, formatFilter: false, classFilter: false,
      textStyleTagFilter: false, attrFilter: true, styleFilter: true,
    },
    convertTextTags: {
      bold: 'strong', italic: 'em', underline: 'u', strike: 's',
      subscript: 'sub', superscript: 'sup',
    },
    elementWhitelist: 'aside|nav|picture|source|track|input|s',
    attributeWhitelist: {
      '*': 'id|class|style|contenteditable|data-studio-embed',
      img: 'id|class|src|srcset|sizes|alt|title|width|height|loading|decoding',
      a: 'id|class|href|title|target|rel',
      th: 'id|class|rowspan|colspan|align',
      td: 'id|class|rowspan|colspan|align',
      iframe: 'id|class|src|width|height|frameborder|allowfullscreen|title',
      video: 'id|class|src|controls|controlslist|autoplay|loop|muted|playsinline|poster|preload|width|height|title',
      audio: 'id|class|src|controls|controlslist|autoplay|loop|muted|preload|title',
      source: 'id|class|src|srcset|sizes|type|media|width|height',
      track: 'id|class|src|kind|srclang|label|default',
      input: 'id|class|type|checked|disabled|aria-label',
    },
  };
}

let converter: SunEditor.Instance | undefined;

export function destroySunEditor(editor: SunEditor.Instance) {
  // SunEditor 3.3.3 disconnects its observers in destroy(), but their queued
  // resize callbacks can still run after the store and frame contexts are gone.
  editor.$.toolbar.resetResponsiveToolbar = () => undefined;
  editor.$.ui._emitResizeEvent = () => undefined;
  // Allow already queued controller blur callbacks to release their state first.
  window.setTimeout(() => editor.destroy(), 0);
}

/** Detached, empty converter: it never stores a document or attaches resources. */
export function cleanSunEditorHtml(html: string): string {
  if (!converter) {
    const host = document.createElement('div');
    const target = document.createElement('div');
    host.append(target);
    converter = suneditor.create(target, {
      ...sunEditorOptions(), plugins: [], buttonList: [], value: '',
    });
  }
  return converter.$.html.clean(html);
}

export { suneditor };
