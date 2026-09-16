import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CircleX,
} from 'lucide-react';
import type { InstallPasswordAssessment } from '../../../contracts/password-policy';
import type { PasswordBreachCheckState } from '../hooks/usePasswordBreachCheck';
import { estimatePasswordStrength } from '../lib/password-strength';
import { StudioIcon } from './primitives';

type RequirementState = 'pending' | 'passed' | 'failed' | 'warning';

type StrengthState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; score: number }
  | { state: 'unavailable' };

function RequirementIcon({ state }: { state: RequirementState }) {
  if (state === 'passed') {
    return <StudioIcon icon={CircleCheck} />;
  }
  if (state === 'failed') {
    return <StudioIcon icon={CircleX} />;
  }
  if (state === 'warning') {
    return <StudioIcon icon={CircleAlert} />;
  }
  return <StudioIcon icon={CircleMinus} />;
}

function RequirementRow(input: {
  label: string;
  state: RequirementState;
}) {
  const { t } = useTranslation('install');

  return (
    <li
      className="setup-requirement"
      data-state={input.state}
    >
      <RequirementIcon state={input.state} />
      <span>{input.label}</span>
      <span className="visually-hidden">
        {t(`assessment.requirementState.${input.state}`)}
      </span>
    </li>
  );
}

function requirementState(
  hasPassword: boolean,
  result: boolean,
): RequirementState {
  if (!hasPassword) return 'pending';
  return result ? 'passed' : 'failed';
}

function getStrengthLabelKey(score: number) {
  switch (score) {
    case 0:
      return 'assessment.strength.veryWeak';
    case 1:
      return 'assessment.strength.weak';
    case 2:
      return 'assessment.strength.fair';
    case 3:
      return 'assessment.strength.strong';
    default:
      return 'assessment.strength.veryStrong';
  }
}

export function InstallPasswordAssessment(input: {
  password: string;
  confirmPassword: string;
  email: string;
  displayName: string;
  assessment: InstallPasswordAssessment;
  breach: PasswordBreachCheckState;
}) {
  const { t } = useTranslation('install');
  const [strength, setStrength] = useState<StrengthState>({ state: 'idle' });
  const hasPassword = input.password.length > 0;
  const lengthReady = (
    input.assessment.requirements.minimum_length
    && input.assessment.requirements.maximum_length
  );

  useEffect(() => {
    if (!input.password) {
      setStrength({ state: 'idle' });
      return;
    }

    let active = true;
    setStrength({ state: 'loading' });
    const timeoutId = window.setTimeout(() => {
      void estimatePasswordStrength({
        password: input.password,
        email: input.email,
        displayName: input.displayName,
      }).then((result) => {
        if (active) {
          setStrength({ state: 'ready', score: result.score });
        }
      }).catch(() => {
        if (active) {
          setStrength({ state: 'unavailable' });
        }
      });
    }, 150);

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [
    input.displayName,
    input.email,
    input.password,
  ]);

  const score = strength.state === 'ready' ? strength.score : null;
  const strengthLabel = score === null
    ? null
    : t(getStrengthLabelKey(score));
  const contextState: RequirementState = !hasPassword || !lengthReady
    ? 'pending'
    : requirementState(
        true,
        input.assessment.requirements.context_independent,
      );
  const uncommonState: RequirementState = !hasPassword
    || !lengthReady
    || !input.assessment.requirements.context_independent
      ? 'pending'
      : !input.assessment.requirements.uncommon
        ? 'failed'
        : input.breach.status === 'clear'
          ? 'passed'
          : input.breach.status === 'hit'
            ? 'failed'
            : input.breach.status === 'unavailable'
              ? 'warning'
              : 'pending';
  const confirmationState: RequirementState = input.confirmPassword.length === 0
    ? 'pending'
    : requirementState(
        true,
        input.password === input.confirmPassword,
      );

  return (
    <section
      className="setup-strength setup-field-wide"
      aria-labelledby="setup-strength-title"
    >
      <div className="setup-strength-meter">
        <div className="setup-strength-heading">
          <h2 className="setup-strength-title" id="setup-strength-title">
            {t('assessment.title')}
          </h2>
          <p className="setup-strength-note" aria-live="polite">
            {strength.state === 'loading'
              ? t('assessment.strength.loading')
              : strength.state === 'unavailable'
                ? t('assessment.strength.unavailable')
                : strengthLabel
                  ? t('assessment.strength.result', {
                      strength: strengthLabel,
                    })
                  : t('assessment.strength.waiting')}
          </p>
        </div>

        <div
          className="setup-strength-bars"
          role={score === null ? undefined : 'meter'}
          aria-label={
            score === null
              ? undefined
              : t('assessment.strength.meterLabel')
          }
          aria-valuemin={score === null ? undefined : 0}
          aria-valuemax={score === null ? undefined : 4}
          aria-valuenow={score ?? undefined}
          aria-valuetext={strengthLabel ?? undefined}
          data-score={score ?? 'pending'}
        >
          {[0, 1, 2, 3, 4].map((index) => (
            <span
              className="setup-strength-bar"
              key={index}
              data-filled={score !== null && index <= score}
              aria-hidden="true"
            />
          ))}
        </div>
      </div>

      <ul
        className="setup-requirements"
        aria-label={t('assessment.requirementsLabel')}
      >
        <RequirementRow
          label={t('assessment.requirements.length')}
          state={requirementState(
            hasPassword,
            lengthReady,
          )}
        />
        <RequirementRow
          label={t('assessment.requirements.contextIndependent')}
          state={contextState}
        />
        <RequirementRow
          label={input.breach.status === 'unavailable'
            ? t('assessment.requirements.breachUnavailable')
            : t('assessment.requirements.uncommon')}
          state={uncommonState}
        />
        <RequirementRow
          label={t('assessment.requirements.matches')}
          state={confirmationState}
        />
      </ul>

      <p className="setup-guidance">{t('assessment.guidance')}</p>
    </section>
  );
}
