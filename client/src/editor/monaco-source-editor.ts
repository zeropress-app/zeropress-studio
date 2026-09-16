import {
  Selection,
  editor,
} from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/editor/browser/coreCommands.js';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js';
import 'monaco-editor/features/find/register.js';
import 'monaco-editor/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/editor/contrib/indentation/browser/indentation.js';
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
  type MonacoSourceLanguage,
} from './monaco-runtime';

export type MonacoSourceEditorRuntimeHandle = {
  dispose: () => void;
  focus: () => void;
  getValue: () => string;
  getSelectionRange: () => { start: number; end: number } | null;
  insertText: (value: string) => boolean;
  setDisabled: (disabled: boolean) => void;
  setDocumentType: (documentType: MonacoSourceLanguage) => void;
  setMaximumLength: (maximumLength?: number) => void;
  setValue: (value: string) => void;
};

/**
 * Creates one editable source model. Models are scoped to the mounted content
 * editor and are disposed on route/mode changes so authored source is not left
 * in Monaco's global model registry.
 */
export function createMonacoSourceEditor(input: {
  container: HTMLElement;
  value: string;
  documentType: MonacoSourceLanguage;
  maximumLength?: number;
  disabled: boolean;
  ariaLabel: string;
  onChange: (value: string) => void;
  onLimitExceeded: () => void;
}): MonacoSourceEditorRuntimeHandle {
  ensureMonacoEditorWorker();
  applyMonacoTheme();

  const model = editor.createModel(
    input.value,
    monacoLanguageFor(input.documentType),
  );
  const fontFamily = getComputedStyle(input.container)
    .getPropertyValue('--studio-font-mono')
    .trim();
  const sourceEditor = editor.create(input.container, {
    model,
    readOnly: input.disabled,
    domReadOnly: input.disabled,
    ariaLabel: input.ariaLabel,
    automaticLayout: true,
    wordWrap: 'on',
    wrappingStrategy: 'advanced',
    scrollBeyondLastLine: false,
    minimap: { enabled: false },
    overviewRulerLanes: 0,
    links: false,
    contextmenu: true,
    glyphMargin: false,
    lineNumbers: 'on',
    lineNumbersMinChars: 3,
    renderLineHighlight: 'line',
    renderValidationDecorations: 'off',
    folding: input.documentType !== 'plaintext',
    stickyScroll: { enabled: false },
    guides: {
      indentation: true,
      bracketPairs: true,
    },
    bracketPairColorization: { enabled: true },
    formatOnPaste: false,
    formatOnType: false,
    detectIndentation: true,
    trimAutoWhitespace: false,
    tabFocusMode: true,
    accessibilitySupport: 'auto',
    padding: { top: 14, bottom: 14 },
    fontFamily: fontFamily || undefined,
    fontSize: 13,
    lineHeight: 21,
  });

  let maximumLength = input.maximumLength;
  let acceptedValue = input.value;
  let acceptedSelection = sourceEditor.getSelection();
  let applyingProgrammaticValue = false;
  const contentListener = model.onDidChangeContent(() => {
    if (applyingProgrammaticValue) return;
    const value = model.getValue();
    if (maximumLength !== undefined && value.length > maximumLength) {
      applyingProgrammaticValue = true;
      model.setValue(acceptedValue);
      if (acceptedSelection) sourceEditor.setSelection(acceptedSelection);
      applyingProgrammaticValue = false;
      input.onLimitExceeded();
      return;
    }
    acceptedValue = value;
    acceptedSelection = sourceEditor.getSelection();
    input.onChange(value);
  });
  const selectionListener = sourceEditor.onDidChangeCursorSelection((event) => {
    if (!applyingProgrammaticValue) acceptedSelection = event.selection;
  });
  const themeObserver = observeMonacoTheme();

  return {
    dispose() {
      contentListener.dispose();
      selectionListener.dispose();
      themeObserver.disconnect();
      sourceEditor.setModel(null);
      sourceEditor.dispose();
      model.dispose();
    },
    focus: () => sourceEditor.focus(),
    getValue: () => model.getValue(),
    getSelectionRange() {
      const selection = sourceEditor.getSelection();
      if (!selection) return null;
      return {
        start: model.getOffsetAt(selection.getStartPosition()),
        end: model.getOffsetAt(selection.getEndPosition()),
      };
    },
    insertText(value) {
      if (sourceEditor.getOption(editor.EditorOption.readOnly)) return false;
      const selection = sourceEditor.getSelection();
      if (!selection) return false;
      const selectedLength = model.getValueLengthInRange(selection);
      if (
        maximumLength !== undefined
        && model.getValueLength() - selectedLength + value.length > maximumLength
      ) {
        input.onLimitExceeded();
        return false;
      }
      const insertionOffset = model.getOffsetAt(selection.getStartPosition());
      sourceEditor.executeEdits('zeropress-media-insertion', [{
        range: selection,
        text: value,
        forceMoveMarkers: true,
      }]);
      const end = model.getPositionAt(insertionOffset + value.length);
      sourceEditor.setSelection(new Selection(
        end.lineNumber,
        end.column,
        end.lineNumber,
        end.column,
      ));
      sourceEditor.focus();
      return true;
    },
    setDisabled(disabled) {
      sourceEditor.updateOptions({ readOnly: disabled, domReadOnly: disabled });
    },
    setDocumentType(documentType) {
      editor.setModelLanguage(model, monacoLanguageFor(documentType));
      sourceEditor.updateOptions({ folding: documentType !== 'plaintext' });
    },
    setMaximumLength(value) {
      maximumLength = value;
    },
    setValue(value) {
      if (value === model.getValue()) return;
      const offset = model.getOffsetAt(
        sourceEditor.getPosition() ?? model.getPositionAt(0),
      );
      applyingProgrammaticValue = true;
      model.setValue(value);
      applyingProgrammaticValue = false;
      acceptedValue = value;
      const position = model.getPositionAt(Math.min(offset, value.length));
      acceptedSelection = new Selection(
        position.lineNumber,
        position.column,
        position.lineNumber,
        position.column,
      );
      sourceEditor.setSelection(acceptedSelection);
    },
  };
}
