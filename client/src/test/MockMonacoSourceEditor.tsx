import {
  forwardRef,
  useImperativeHandle,
  useRef,
} from 'react';
import type { MonacoSourceEditorHandle } from '../components/MonacoSourceEditor';

/** A controlled textarea stand-in for page/component tests outside Monaco. */
export const MockMonacoSourceEditor = forwardRef<
  MonacoSourceEditorHandle,
  {
    id: string;
    describedBy?: string;
    invalid?: boolean;
    value: string;
    documentType?: string;
    maximumLength?: number;
    disabled: boolean;
    label: string;
    onChange: (value: string) => void;
    onLimitExceeded?: () => void;
  }
>(function MockMonacoSourceEditor(input, ref) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef(input);
  inputRef.current = input;

  useImperativeHandle(ref, () => ({
    flush: () => inputRef.current.value,
    focus: () => textareaRef.current?.focus(),
    getSelectionRange: () => {
      const textarea = textareaRef.current;
      if (!textarea) return null;
      return {
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
      };
    },
    insertText(value) {
      const textarea = textareaRef.current;
      if (!textarea || inputRef.current.disabled) return false;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const next = `${inputRef.current.value.slice(0, start)}${value}${inputRef.current.value.slice(end)}`;
      if (
        inputRef.current.maximumLength !== undefined
        && next.length > inputRef.current.maximumLength
      ) {
        inputRef.current.onLimitExceeded?.();
        return false;
      }
      inputRef.current.onChange(next);
      return true;
    },
  }));

  return (
    <textarea
      ref={textareaRef}
      id={input.id}
      aria-label={input.label}
      aria-describedby={input.describedBy}
      aria-invalid={input.invalid}
      data-document-type={input.documentType}
      value={input.value}
      maxLength={input.maximumLength}
      disabled={input.disabled}
      onChange={(event) => input.onChange(event.target.value)}
    />
  );
});
