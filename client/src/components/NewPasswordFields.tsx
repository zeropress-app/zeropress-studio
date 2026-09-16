import {
  Eye,
  EyeOff,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../../../contracts/password-policy';
import { Field, StudioIcon } from './primitives';

type NewPasswordFieldLabels = {
  password: string;
  confirmPassword: string;
  passwordPlaceholder: string;
  confirmPasswordPlaceholder: string;
  showPassword: string;
  hidePassword: string;
};

/**
 * New-password fields shared by initial installation and account activation.
 *
 * The caller evaluates password policy. This component keeps icons, autocomplete, visibility
 * controls, and error presentation consistent across both screens.
 */
export function NewPasswordFields(input: {
  password: string;
  confirmPassword: string;
  revealed: boolean;
  disabled?: boolean;
  passwordInvalid?: boolean;
  confirmationInvalid?: boolean;
  labels: NewPasswordFieldLabels;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onRevealedChange: (revealed: boolean) => void;
}) {
  return (
    <>
      <Field label={input.labels.password}>
        {(control) => (
          <div className="auth-input setup-password">
            <StudioIcon icon={LockKeyhole} />
            <input
              {...control}
              name="new-password"
              type={input.revealed ? 'text' : 'password'}
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              required
              aria-invalid={input.passwordInvalid || undefined}
              value={input.password}
              placeholder={input.labels.passwordPlaceholder}
              disabled={input.disabled}
              onChange={(event) => input.onPasswordChange(event.target.value)}
            />
            <button
              className="setup-password-action"
              type="button"
              aria-label={input.revealed
                ? input.labels.hidePassword
                : input.labels.showPassword}
              aria-pressed={input.revealed}
              title={input.revealed
                ? input.labels.hidePassword
                : input.labels.showPassword}
              disabled={input.disabled}
              onClick={() => input.onRevealedChange(!input.revealed)}
            >
              <StudioIcon icon={input.revealed ? EyeOff : Eye} />
            </button>
          </div>
        )}
      </Field>

      <Field label={input.labels.confirmPassword}>
        {(control) => (
          <div className="auth-input">
            <StudioIcon icon={ShieldCheck} />
            <input
              {...control}
              name="confirm-password"
              type={input.revealed ? 'text' : 'password'}
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              required
              aria-invalid={input.confirmationInvalid || undefined}
              value={input.confirmPassword}
              placeholder={input.labels.confirmPasswordPlaceholder}
              disabled={input.disabled}
              onChange={(event) => input.onConfirmPasswordChange(
                event.target.value,
              )}
            />
          </div>
        )}
      </Field>
    </>
  );
}
