import type {
  ButtonHTMLAttributes,
  ReactNode,
  Ref,
} from 'react';
import { classNames } from './class-names';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'text';

/**
 * Button.
 *
 * Require an explicit type with no default. Omitting it inside a form can trigger an unintended
 * submission.
 */
export function Button(input: {
  type: 'button' | 'submit' | 'reset';
  /** Use text for actions presented as clickable text, such as a list item name. */
  variant?: ButtonVariant;
  /**
   * Use lg for a screen's single primary action, such as login or installation progress. Do not
   * use it in lists or ordinary forms.
   */
  size?: 'md' | 'sm' | 'lg';
  /** Fill the container width. */
  block?: boolean;
  /**
   * Allow callers to reference the element directly, for example to focus this button when a
   * dialog opens.
   */
  ref?: Ref<HTMLButtonElement>;
  children: ReactNode;
} & Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'type' | 'children'
>) {
  const {
    type,
    variant = 'secondary',
    size = 'md',
    block,
    children,
    ...rest
  } = input;

  return (
    <button
      {...rest}
      type={type}
      className={classNames(
        'studio-button',
        `studio-button-${variant}`,
        size !== 'md' && `studio-button-${size}`,
        block && 'studio-button-block',
      )}
    >
      {children}
    </button>
  );
}
