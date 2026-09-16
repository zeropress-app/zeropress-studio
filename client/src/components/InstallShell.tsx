import type { ReactNode, Ref } from 'react';
import { LocaleSwitcher } from './LocaleSwitcher';
import { LogoBadge } from './LogoBadge';
import {
  StudioInstallationProgress,
  type StudioInstallationProgressState,
} from './StudioInstallationProgress';
import { ThemeToggle } from './ThemeToggle';

type InstallationStep = Exclude<
  StudioInstallationProgressState,
  'complete'
>;

type InstallHeading = {
  kicker: string;
  title: string;
  description: string;
  role?: 'alert' | 'status';
};

type InstallStepHeadings = Record<InstallationStep, InstallHeading>;

const installationSteps: readonly InstallationStep[] = [
  'license',
  'information',
  'mfa',
];

type InstallShellProps = {
  regionLabel: string;
  children: ReactNode;
} & (
  | {
      current: InstallationStep;
      headings: InstallStepHeadings;
      titleRef?: Ref<HTMLHeadingElement>;
      heading?: never;
    }
  | {
      current: 'complete';
      heading: InstallHeading & {
        titleRef?: Ref<HTMLHeadingElement>;
      };
      headings?: never;
      titleRef?: never;
    }
);

function InstallRailHeading(input: {
  active: boolean;
  heading: InstallHeading;
  titleRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <header
      className="setup-header setup-header-install"
      data-active={input.active ? 'true' : 'false'}
      aria-hidden={input.active ? undefined : true}
      role={input.active ? input.heading.role : undefined}
    >
      <p className="auth-kicker">{input.heading.kicker}</p>
      <h1
        className="setup-title"
        ref={input.active ? input.titleRef : undefined}
        tabIndex={input.active ? -1 : undefined}
      >
        {input.heading.title}
      </h1>
      <p className="setup-description">
        {input.heading.description}
      </p>
    </header>
  );
}

/**
 * Shell for the installation journey.
 *
 * InstallPage and installation completion share progress context. Activation and general
 * system-status screens use their own layouts. Pre-authentication appearance controls share the
 * login locale and theme implementation.
 */
export function InstallShell(input: InstallShellProps) {
  return (
    <main className="auth-shell auth-shell-install">
      <section
        className="auth-frame auth-frame-install"
        aria-label={input.regionLabel}
      >
        <div className="auth-install-rail">
          <p className="auth-lockup">
            <LogoBadge />
            <span>
              ZeroPress{' '}
              <strong className="auth-lockup-emphasis">Studio</strong>
            </span>
          </p>

          <div className="auth-install-header-slot">
            {input.current === 'complete' ? (
              <InstallRailHeading
                active
                heading={input.heading}
                titleRef={input.heading.titleRef}
              />
            ) : installationSteps.map((step) => (
              // Hidden headings still size the shared grid cell, so changing
              // steps does not move the progress navigation below it.
              <InstallRailHeading
                key={step}
                active={step === input.current}
                heading={input.headings[step]}
                titleRef={input.titleRef}
              />
            ))}
          </div>

          <StudioInstallationProgress current={input.current} />
        </div>

        <div className="auth-install-panel">
          <div className="auth-install-controls">
            <ThemeToggle />
            <LocaleSwitcher />
          </div>
          <div className="auth-install-content">{input.children}</div>
        </div>
      </section>
    </main>
  );
}
