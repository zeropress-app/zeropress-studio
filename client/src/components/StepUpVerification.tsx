import { Callout, Field } from './primitives';

/**
 * Reauthentication method. webauthn is available only when this browser has a passkey for the
 * current host.
 */
export type StepUpMethod = 'totp' | 'webauthn';

/**
 * Reauthentication inputs for sensitive actions.
 *
 * MFA management, password changes, and passkey management share this markup and TOTP
 * normalization to keep autocomplete and input behavior consistent.
 *
 * Callers own state because submission includes both the method and code, and each screen handles
 * verification failures differently.
 */
export function StepUpVerification(input: {
  /**
   * Radio-group name, chosen by the caller because two forms may coexist in one document. Reusing
   * a name would clear the other form's selection.
   */
  name: string;
  /**
   * Whether reauthentication is required. If verification is still recent, show that state instead
   * of inputs. This branch is shared by all three screens.
   */
  required: boolean;
  method: StepUpMethod;
  onMethodChange: (method: StepUpMethod) => void;
  code: string;
  onCodeChange: (code: string) => void;
  /** Whether passkey reauthentication is available. */
  webAuthnAvailable: boolean;
  disabled?: boolean;
  /** Translated text. */
  copy: {
    legend: string;
    notRequired: string;
    webauthn: string;
    webauthnPrompt: string;
    totp: string;
    totpCode: string;
  };
}) {
  if (!input.required) {
    return <Callout tone="info">{input.copy.notRequired}</Callout>;
  }

  const methods: ReadonlyArray<{ value: StepUpMethod; label: string }> = [
    ...(input.webAuthnAvailable
      ? [{ value: 'webauthn' as const, label: input.copy.webauthn }]
      : []),
    { value: 'totp', label: input.copy.totp },
  ];

  return (
    <fieldset className="account-step-up">
      <legend className="account-step-up-legend">{input.copy.legend}</legend>
      <div className="account-step-up-methods">
        {methods.map(({ value, label }) => (
          <label className="account-step-up-option" key={value}>
            <input
              type="radio"
              name={input.name}
              value={value}
              checked={input.method === value}
              disabled={input.disabled}
              onChange={() => {
                input.onMethodChange(value);
                // Clear the previous input when switching methods because its format changes.
                input.onCodeChange('');
              }}
            />
            {label}
          </label>
        ))}
      </div>
      {input.method === 'webauthn' ? (
        <Callout tone="info">{input.copy.webauthnPrompt}</Callout>
      ) : (
        <Field label={input.copy.totpCode}>
          {(control) => (
            <input
              {...control}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={input.code}
              disabled={input.disabled}
              required
              onChange={(event) => input.onCodeChange(
                event.target.value.replace(/\D/gu, '').slice(0, 6),
              )}
            />
          )}
        </Field>
      )}
    </fieldset>
  );
}
