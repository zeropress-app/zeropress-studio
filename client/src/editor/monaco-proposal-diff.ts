import { editor } from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/editor/browser/coreCommands.js';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js';
import 'monaco-editor/features/find/register.js';
import 'monaco-editor/editor/contrib/lineSelection/browser/lineSelection.js';
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js';
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js';
import 'monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js';
import 'monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js';
import {
  applyMonacoTheme,
  ensureMonacoEditorWorker,
  monacoLanguageFor,
  observeMonacoTheme,
  type MonacoDocumentType,
} from './monaco-runtime';

export type MonacoProposalDiffHandle = {
  dispose: () => void;
};

/**
 * Review-only proposal editor. The original model is immutable while the
 * modified side remains editable and can revert individual Monaco hunks.
 * Raw source is used because the modified model can become authored content.
 */
export function createMonacoProposalDiff(input: {
  container: HTMLElement;
  original: string;
  modified: string;
  documentType: MonacoDocumentType;
  originalLabel: string;
  modifiedLabel: string;
  onChange: (value: string) => void;
  onComputationUnavailable: () => void;
}): MonacoProposalDiffHandle {
  ensureMonacoEditorWorker();
  applyMonacoTheme();

  let originalModel: editor.ITextModel | null = null;
  let modifiedModel: editor.ITextModel | null = null;
  let diffEditor: editor.IStandaloneDiffEditor | null = null;
  let changeListener: { dispose: () => void } | null = null;
  let computationListener: { dispose: () => void } | null = null;
  let timer: number | null = null;
  let themeObserver: MutationObserver | null = null;

  try {
    originalModel = editor.createModel(
      input.original,
      monacoLanguageFor(input.documentType),
    );
    modifiedModel = editor.createModel(
      input.modified,
      monacoLanguageFor(input.documentType),
    );
    const fontFamily = getComputedStyle(input.container)
      .getPropertyValue('--studio-font-mono')
      .trim();
    diffEditor = editor.createDiffEditor(input.container, {
      readOnly: false,
      domReadOnly: false,
      originalEditable: false,
      renderMarginRevertIcon: true,
      renderGutterMenu: true,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: true,
      renderSideBySideInlineBreakpoint: 640,
      diffAlgorithm: 'advanced',
      ignoreTrimWhitespace: false,
      maxComputationTime: 5_000,
      maxFileSize: 50,
      diffWordWrap: 'on',
      wordWrap: 'on',
      wrappingStrategy: 'advanced',
      automaticLayout: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      renderOverviewRuler: false,
      overviewRulerLanes: 0,
      links: false,
      contextmenu: true,
      glyphMargin: true,
      lineNumbers: 'on',
      renderLineHighlight: 'line',
      renderValidationDecorations: 'off',
      folding: false,
      stickyScroll: { enabled: false },
      guides: { indentation: false, bracketPairs: false },
      bracketPairColorization: { enabled: false },
      padding: { top: 12, bottom: 12 },
      fontFamily: fontFamily || undefined,
      fontSize: 12,
      lineHeight: 20,
      tabFocusMode: true,
      accessibilitySupport: 'auto',
      accessibilityVerbose: true,
      hideUnchangedRegions: {
        enabled: input.original !== input.modified,
        contextLineCount: 3,
        minimumLineCount: 8,
        revealLineCount: 20,
      },
    });
    diffEditor.getOriginalEditor().updateOptions({
      readOnly: true,
      domReadOnly: true,
      ariaLabel: input.originalLabel,
    });
    diffEditor.getModifiedEditor().updateOptions({
      readOnly: false,
      domReadOnly: false,
      ariaLabel: input.modifiedLabel,
    });
    diffEditor.setModel({ original: originalModel, modified: modifiedModel });

    changeListener = modifiedModel.onDidChangeContent(() => {
      input.onChange(modifiedModel?.getValue() ?? input.modified);
    });
    let computationFinished = diffEditor.getLineChanges() !== null;
    computationListener = diffEditor.onDidUpdateDiff(() => {
      computationFinished = diffEditor?.getLineChanges() !== null;
      if (computationFinished && timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    });
    if (!computationFinished) {
      timer = window.setTimeout(() => {
        timer = null;
        if (diffEditor?.getLineChanges() === null) {
          input.onComputationUnavailable();
        }
      }, 5_500);
    }
    themeObserver = observeMonacoTheme();

    return {
      dispose() {
        changeListener?.dispose();
        computationListener?.dispose();
        if (timer !== null) window.clearTimeout(timer);
        themeObserver?.disconnect();
        diffEditor?.setModel(null);
        diffEditor?.dispose();
        originalModel?.dispose();
        modifiedModel?.dispose();
      },
    };
  } catch (error) {
    changeListener?.dispose();
    computationListener?.dispose();
    if (timer !== null) window.clearTimeout(timer);
    themeObserver?.disconnect();
    diffEditor?.setModel(null);
    diffEditor?.dispose();
    originalModel?.dispose();
    modifiedModel?.dispose();
    throw error;
  }
}
