import type { ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { LocaleSwitcher } from './LocaleSwitcher';
import { LogoBadge } from './LogoBadge';
import { ThemeToggle } from './ThemeToggle';
import { StudioIcon } from './primitives';

export type UserActivationStep = 'password' | 'mfa';

export type UserActivationHeading = {
  kicker: string;
  title: string;
  description: string;
};

const activationSteps: readonly UserActivationStep[] = [
  'password',
  'mfa',
];

function UserActivationProgress({
  current,
}: {
  current: UserActivationStep;
}) {
  const { t } = useTranslation('users');
  const currentIndex = activationSteps.indexOf(current);

  return (
    <nav
      className="setup-progress"
      aria-label={t('activation.progress.label')}
    >
      <ol className="setup-progress-list">
        {activationSteps.map((step, index) => {
          const state = index < currentIndex
            ? 'completed'
            : index === currentIndex
              ? 'current'
              : 'pending';
          return (
            <li
              className="setup-progress-step"
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
              key={step}
            >
              <span className="setup-progress-marker" aria-hidden="true">
                {state === 'completed' ? (
                  <StudioIcon icon={Check} />
                ) : index + 1}
              </span>
              <span className="setup-progress-label">
                {t(`activation.progress.items.${step}`)}
              </span>
              <span className="visually-hidden">
                {t(`activation.progress.states.${state}`)}
              </span>
              {index < activationSteps.length - 1 ? (
                <span
                  className="setup-progress-connector"
                  aria-hidden="true"
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function UserActivationRailHeading(input: {
  active: boolean;
  heading: UserActivationHeading;
  titleRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <header
      className="setup-header setup-header-activation"
      data-active={input.active ? 'true' : 'false'}
      aria-hidden={input.active ? undefined : true}
    >
      <p className="auth-kicker">{input.heading.kicker}</p>
      <h1
        className="setup-title"
        ref={input.active ? input.titleRef : undefined}
        tabIndex={input.active ? -1 : undefined}
      >
        {input.heading.title}
      </h1>
      <p className="setup-description">{input.heading.description}</p>
    </header>
  );
}

/** Account invitation and credential recovery share this two-step shell. */
export function UserActivationShell(input: {
  regionLabel: string;
  current: UserActivationStep;
  headings: Record<UserActivationStep, UserActivationHeading>;
  titleRef?: Ref<HTMLHeadingElement>;
  children: ReactNode;
}) {
  return (
    <main className="auth-shell auth-shell-activation">
      <section
        className="auth-frame auth-frame-activation"
        aria-label={input.regionLabel}
      >
        <div className="auth-activation-rail">
          <p className="auth-lockup">
            <LogoBadge />
            <span>
              ZeroPress{' '}
              <strong className="auth-lockup-emphasis">Studio</strong>
            </span>
          </p>

          <div className="auth-activation-header-slot">
            {activationSteps.map((step) => (
              <UserActivationRailHeading
                key={step}
                active={step === input.current}
                heading={input.headings[step]}
                titleRef={input.titleRef}
              />
            ))}
          </div>

          <UserActivationProgress current={input.current} />
        </div>

        <div className="auth-activation-panel">
          <div className="auth-activation-controls">
            <ThemeToggle />
            <LocaleSwitcher />
          </div>
          <div className="auth-activation-content">{input.children}</div>
        </div>
      </section>
    </main>
  );
}
