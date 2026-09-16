import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import {
  createMonacoSourceEditor,
  type MonacoSourceEditorRuntimeHandle,
} from '../editor/monaco-source-editor';
import type { MonacoSourceLanguage } from '../editor/monaco-runtime';

export type MonacoSourceEditorHandle = {
  flush: () => string;
  focus: () => void;
  insertText: (value: string) => boolean;
  getSelectionRange: () => { start: number; end: number } | null;
};

export const MonacoSourceEditor = forwardRef<
  MonacoSourceEditorHandle,
  {
    id: string;
    describedBy?: string;
    invalid?: boolean;
    value: string;
    documentType: MonacoSourceLanguage;
    maximumLength?: number;
    disabled: boolean;
    label: string;
    onChange: (value: string) => void;
    onLimitExceeded?: () => void;
    onUnavailable: () => void;
  }
>(function MonacoSourceEditor(input, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<MonacoSourceEditorRuntimeHandle | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    try {
      const runtime = createMonacoSourceEditor({
        container,
        value: inputRef.current.value,
        documentType: inputRef.current.documentType,
        maximumLength: inputRef.current.maximumLength,
        disabled: inputRef.current.disabled,
        ariaLabel: inputRef.current.label,
        onChange: (value) => inputRef.current.onChange(value),
        onLimitExceeded: () => inputRef.current.onLimitExceeded?.(),
      });
      runtimeRef.current = runtime;
      return () => {
        runtimeRef.current = null;
        runtime.dispose();
      };
    } catch {
      inputRef.current.onUnavailable();
      return undefined;
    }
  }, []);

  useEffect(() => runtimeRef.current?.setValue(input.value), [input.value]);
  useEffect(() => runtimeRef.current?.setDisabled(input.disabled), [input.disabled]);
  useEffect(() => runtimeRef.current?.setDocumentType(input.documentType), [input.documentType]);
  useEffect(() => runtimeRef.current?.setMaximumLength(input.maximumLength), [input.maximumLength]);

  useImperativeHandle(ref, () => ({
    flush: () => runtimeRef.current?.getValue() ?? inputRef.current.value,
    focus: () => runtimeRef.current?.focus(),
    insertText: (value) => runtimeRef.current?.insertText(value) ?? false,
    getSelectionRange: () => runtimeRef.current?.getSelectionRange() ?? null,
  }));

  return (
    <div
      ref={containerRef}
      id={input.id}
      className="content-editor-source-monaco"
      role="group"
      aria-label={input.label}
      aria-describedby={input.describedBy}
      aria-invalid={input.invalid}
    />
  );
});
