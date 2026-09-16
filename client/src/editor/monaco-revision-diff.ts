import {
  editor,
} from 'monaco-editor/editor/editor.api.js';
import {
  applyMonacoTheme,
  ensureMonacoEditorWorker,
  monacoLanguageFor,
  observeMonacoTheme,
  type MonacoDocumentType,
} from './monaco-runtime';

export type RevisionDiffDocumentType = MonacoDocumentType;

export type RevisionDiffHandle = {
  dispose: () => void;
};

/**
 * Creates one read-only diff instance. The caller owns the returned handle and
 * must dispose it before removing the container. Monaco models are deliberately
 * local to the dialog so revision source never remains in a global model cache.
 */
export function createMonacoRevisionDiff(input: {
  container: HTMLElement;
  original: string;
  modified: string;
  originalDocumentType: RevisionDiffDocumentType;
  modifiedDocumentType: RevisionDiffDocumentType;
  originalLabel: string;
  modifiedLabel: string;
  onComputationUnavailable: () => void;
}): RevisionDiffHandle {
  ensureMonacoEditorWorker();
  applyMonacoTheme();

  let originalModel: editor.ITextModel | null = null;
  let modifiedModel: editor.ITextModel | null = null;
  let diffEditor: editor.IStandaloneDiffEditor | null = null;
  let computationListener: { dispose: () => void } | null = null;
  let computationTimer: number | null = null;
  let themeObserver: MutationObserver | null = null;

  try {
    originalModel = editor.createModel(
      input.original,
      monacoLanguageFor(input.originalDocumentType),
    );
    modifiedModel = editor.createModel(
      input.modified,
      monacoLanguageFor(input.modifiedDocumentType),
    );
    const fontFamily = getComputedStyle(input.container)
      .getPropertyValue('--studio-font-mono')
      .trim();
    diffEditor = editor.createDiffEditor(input.container, {
      readOnly: true,
      domReadOnly: true,
      originalEditable: false,
      renderMarginRevertIcon: false,
      renderGutterMenu: false,
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
      renderLineHighlight: 'none',
      renderValidationDecorations: 'off',
      selectionHighlight: false,
      occurrencesHighlight: 'off',
      folding: false,
      stickyScroll: { enabled: false },
      guides: {
        indentation: false,
        bracketPairs: false,
      },
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
      ariaLabel: input.originalLabel,
    });
    diffEditor.getModifiedEditor().updateOptions({
      ariaLabel: input.modifiedLabel,
    });
    diffEditor.setModel({ original: originalModel, modified: modifiedModel });

    let computationFinished = diffEditor.getLineChanges() !== null;
    computationListener = diffEditor.onDidUpdateDiff(() => {
      computationFinished = diffEditor?.getLineChanges() !== null;
      if (computationFinished && computationTimer !== null) {
        window.clearTimeout(computationTimer);
        computationTimer = null;
      }
    });
    if (!computationFinished) {
      computationTimer = window.setTimeout(() => {
        computationTimer = null;
        if (diffEditor?.getLineChanges() === null) {
          input.onComputationUnavailable();
        }
      }, 5_500);
    }

    themeObserver = observeMonacoTheme();
  } catch (error) {
    computationListener?.dispose();
    if (computationTimer !== null) window.clearTimeout(computationTimer);
    themeObserver?.disconnect();
    diffEditor?.setModel(null);
    diffEditor?.dispose();
    originalModel?.dispose();
    modifiedModel?.dispose();
    throw error;
  }

  return {
    dispose() {
      computationListener?.dispose();
      if (computationTimer !== null) window.clearTimeout(computationTimer);
      themeObserver?.disconnect();
      diffEditor?.setModel(null);
      diffEditor?.dispose();
      originalModel?.dispose();
      modifiedModel?.dispose();
    },
  };
}
