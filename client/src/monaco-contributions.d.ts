// Monaco exposes contribution registration as side-effect ESM modules without
// individual declaration files. Keep this allowlist aligned with the pinned
// Monaco version instead of importing editor.main and every bundled language.
declare module 'monaco-editor/editor/browser/coreCommands.js';
declare module 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';
declare module 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js';
declare module 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
declare module 'monaco-editor/editor/contrib/comment/browser/comment.js';
declare module 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js';
declare module 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js';
declare module 'monaco-editor/features/find/register.js';
declare module 'monaco-editor/editor/contrib/folding/browser/folding.js';
declare module 'monaco-editor/editor/contrib/indentation/browser/indentation.js';
declare module 'monaco-editor/editor/contrib/lineSelection/browser/lineSelection.js';
declare module 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js';
declare module 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js';
declare module 'monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js';
declare module 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js';
declare module 'monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js';
