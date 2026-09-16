import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { editor } from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/languages/definitions/css/register.js';
import 'monaco-editor/languages/definitions/html/register.js';
import 'monaco-editor/languages/definitions/markdown/register.js';

export type MonacoDocumentType = 'html' | 'markdown' | 'plaintext';
export type MonacoSourceLanguage = MonacoDocumentType | 'css';

export function ensureMonacoEditorWorker() {
  if (
    globalThis.MonacoEnvironment?.getWorker
    || globalThis.MonacoEnvironment?.getWorkerUrl
  ) return;
  globalThis.MonacoEnvironment = {
    ...globalThis.MonacoEnvironment,
    getWorker: () => new EditorWorker(),
  };
}

export function monacoLanguageFor(documentType: MonacoSourceLanguage) {
  return documentType === 'plaintext' ? 'plaintext' : documentType;
}

export function applyMonacoTheme() {
  editor.setTheme(
    document.documentElement.dataset.theme === 'dark' ? 'vs-dark' : 'vs',
  );
}

export function observeMonacoTheme() {
  const observer = new MutationObserver(applyMonacoTheme);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  return observer;
}
