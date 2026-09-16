import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { classNames } from './class-names';
import type { ButtonVariant } from './Button';

/**
 * Link styled as a button.
 *
 * Navigation must preserve link behavior: opening a new tab, copying the address, previewing the
 * destination, and being announced as navigation. Centralize its button appearance here so screens
 * do not assemble primitive class names that can drift when variants change.
 */
export function ButtonLink(input: {
  to: string;
  variant?: ButtonVariant;
  size?: 'md' | 'sm' | 'lg';
  /** Fill the container width. */
  block?: boolean;
  /** Use only for external destinations opened in a new tab. */
  external?: boolean;
  children: ReactNode;
}) {
  const className = classNames(
    'studio-button',
    `studio-button-${input.variant ?? 'secondary'}`,
    input.size && input.size !== 'md' && `studio-button-${input.size}`,
    input.block && 'studio-button-block',
  );

  if (input.external) {
    return (
      <a
        className={className}
        href={input.to}
        target="_blank"
        rel="noreferrer"
      >
        {input.children}
      </a>
    );
  }

  return (
    <Link className={className} to={input.to}>{input.children}</Link>
  );
}
