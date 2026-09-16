import {
  useId,
  type ReactNode,
} from 'react';
import { classNames } from './class-names';

/**
 * Form-field wrapper.
 *
 * Generate the control ID and aria-describedby links for hints and errors consistently. The render
 * prop receives those attributes for the caller to spread onto the control.
 *
 * <Field label={t('email')} error={emailError}>
 *   {(control) => <input {...control} type="email" value={...} />}
 * </Field>
 */
export function Field(input: {
  /** Translated label. */
  label: string;
  /** Keep the label only in the accessibility tree in compact toolbars. */
  labelHidden?: boolean;
  /** Visual emphasis for the first authoring input, such as a document title. */
  variant?: 'default' | 'title';
  /** Decorative icon at the leading edge of the input. */
  leading?: ReactNode;
  /** Translated supporting description. */
  hint?: string;
  /**
   * Translated supplementary information derived from the current input, such as its normalized
   * stored value.
   *
   * Keep it separate from the value-independent hint. It is not a live region: announcing every
   * keystroke would be noisy, and error already owns authoritative guidance for invalid input.
   */
  note?: string;
  /** Translated error text. Marks the control aria-invalid when present. */
  error?: string;
  /** Supplementary label content, such as an optional-field indicator. */
  labelAdornment?: ReactNode;
  children: (control: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': boolean | undefined;
  }) => ReactNode;
}) {
  const base = useId().replaceAll(':', '');
  const controlId = `${base}-control`;
  const hintId = `${base}-hint`;
  const noteId = `${base}-note`;
  const errorId = `${base}-error`;

  const describedBy = [
    input.hint ? hintId : null,
    input.note ? noteId : null,
    input.error ? errorId : null,
  ].filter((value): value is string => value !== null).join(' ');

  return (
    <div
      className={classNames(
        'studio-field',
        input.variant === 'title' && 'studio-field-title',
      )}
    >
      {input.labelHidden ? (
        <label className="visually-hidden" htmlFor={controlId}>
          {input.label}
        </label>
      ) : (
        <div className="studio-field-label-row">
          <label className="studio-field-label" htmlFor={controlId}>
            {input.label}
          </label>
          {input.labelAdornment ? (
            <span className="studio-field-adornment">
              {input.labelAdornment}
            </span>
          ) : null}
        </div>
      )}
      {input.leading ? (
        <div className="studio-field-control">
          <span className="studio-field-leading">{input.leading}</span>
          {input.children({
            id: controlId,
            'aria-describedby': describedBy.length > 0 ? describedBy : undefined,
            'aria-invalid': input.error ? true : undefined,
          })}
        </div>
      ) : input.children({
        id: controlId,
        'aria-describedby': describedBy.length > 0 ? describedBy : undefined,
        'aria-invalid': input.error ? true : undefined,
      })}
      {input.hint ? (
        <p className="studio-field-hint" id={hintId}>{input.hint}</p>
      ) : null}
      {input.note ? (
        <p className="studio-field-note" id={noteId}>{input.note}</p>
      ) : null}
      {input.error ? (
        <p className="studio-field-error" id={errorId}>{input.error}</p>
      ) : null}
    </div>
  );
}
