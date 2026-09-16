import {
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from 'react';
import { PageHeaderRegistrationContext } from '../page-header-registration';

/**
 * Screen-heading contract.
 *
 * Inside StudioShell, register the translated title and description in the fixed topbar and render
 * only screen-specific actions in the body. Outside the shell, render a complete standalone
 * header. Use once per route to keep one h1; callers may connect titleId to the page root's
 * aria-labelledby.
 */
export function PageHeader(input: {
  /** ID referenced by the page root's aria-labelledby. */
  titleId: string;
  /** Translated title. */
  title: string;
  /** Translated description. */
  description?: string;
  /** Small label above the title. */
  kicker?: string;
  /** Right-side actions. */
  actions?: ReactNode;
}) {
  const registry = useContext(PageHeaderRegistrationContext);
  const registrationId = useRef(Symbol('studio-page-header'));

  // Inside StudioShell, the topbar owns the only visible h1. Register the
  // translated values rendered by the route and leave only screen-specific actions
  // in the body. Outside StudioShell, render the standalone header below.
  useLayoutEffect(() => {
    if (!registry) return;
    registry.register({
      id: registrationId.current,
      titleId: input.titleId,
      title: input.title,
      description: input.description,
    });
  }, [input.description, input.title, input.titleId, registry]);

  useLayoutEffect(() => {
    if (!registry) return;
    const id = registrationId.current;
    return () => registry.unregister(id);
  }, [registry]);

  if (registry) {
    return input.actions ? (
      <div className="studio-page-shell-actions">{input.actions}</div>
    ) : null;
  }

  return (
    <div className="studio-page-header">
      <div className="studio-page-header-heading">
        {input.kicker ? (
          <p className="studio-page-header-kicker">{input.kicker}</p>
        ) : null}
        <h1 className="studio-page-header-title" id={input.titleId}>
          {input.title}
        </h1>
        {input.description ? (
          <p className="studio-page-header-description">{input.description}</p>
        ) : null}
      </div>
      {input.actions ? (
        <div className="studio-page-header-actions">{input.actions}</div>
      ) : null}
    </div>
  );
}
