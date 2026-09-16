import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { StudioIcon } from './primitives';

export type StudioInstallationProgressState =
  | 'license'
  | 'information'
  | 'mfa'
  | 'complete';

type StudioInstallationStep = Exclude<
  StudioInstallationProgressState,
  'complete'
>;

const progressStates: readonly StudioInstallationStep[] = [
  'license',
  'information',
  'mfa',
];

export function StudioInstallationProgress({
  current,
}: {
  current: StudioInstallationProgressState;
}) {
  const { t } = useTranslation('install');
  // complete is the result of all three installation tasks, not a fourth user task.
  // Mark all three steps complete on the completion screen.
  const currentIndex = current === 'complete'
    ? progressStates.length
    : progressStates.indexOf(current);

  return (
    <nav
      className="setup-progress"
      aria-label={t('progress.label')}
    >
      <ol className="setup-progress-list">
        {progressStates.map((progressState, index) => {
          const state = index < currentIndex
            ? 'completed'
            : index === currentIndex
              ? 'current'
              : 'pending';
          return (
            <li
              key={progressState}
              className="setup-progress-step"
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <span
                className="setup-progress-marker"
                aria-hidden="true"
              >
                {state === 'completed' ? (
                  <StudioIcon icon={Check} />
                ) : index + 1}
              </span>
              <span className="setup-progress-label">
                {t(`progress.items.${progressState}`)}
              </span>
              <span className="visually-hidden">
                {t(`progress.states.${state}`)}
              </span>
              {index < progressStates.length - 1 ? (
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
