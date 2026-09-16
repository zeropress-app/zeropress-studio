import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Smartphone } from 'lucide-react';
import type { MfaEnrollmentSetupData } from '../../../contracts/mfa';
import { Field, StudioIcon } from './primitives';

export function MfaEnrollmentPanel(input: {
  enrollment: MfaEnrollmentSetupData;
  totpCode: string;
  account?: {
    label: string;
    value: string;
  };
  disabled?: boolean;
  headingLevel?: 'h2' | 'h3';
  onTotpCodeChange: (value: string) => void;
}) {
  const { t } = useTranslation('common');
  const Heading = input.headingLevel ?? 'h2';
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void import('qrcode')
      .then(({ toDataURL }) => toDataURL(input.enrollment.otpauth_uri, {
        width: 224,
        margin: 1,
        errorCorrectionLevel: 'M',
      }))
      .then((dataUrl) => {
        if (active) setQrCodeDataUrl(dataUrl);
      })
      .catch(() => {
        if (active) setQrCodeDataUrl(null);
      });
    return () => {
      active = false;
    };
  }, [input.enrollment.otpauth_uri]);

  return (
    <div className="auth-enrollment">
      <section className="auth-enrollment-section">
        <header>
          <Heading className="auth-enrollment-title">
            {t('mfa.authenticatorTitle')}
          </Heading>
          <p className="auth-enrollment-description">
            {t('mfa.authenticatorDescription')}
          </p>
        </header>
        <div className="auth-enrollment-grid">
          <div className="auth-qr">
            {qrCodeDataUrl ? (
              <img src={qrCodeDataUrl} alt={t('mfa.qrAlt')} />
            ) : (
              <span role="status">{t('mfa.qrUnavailable')}</span>
            )}
          </div>
          <div className="auth-enrollment-details">
            {input.account ? (
              <dl className="auth-enrollment-account">
                <dt>{input.account.label}</dt>
                <dd>{input.account.value}</dd>
              </dl>
            ) : null}
            <div className="auth-manual-key">
              <span>{t('mfa.manualKey')}</span>
              <code>{input.enrollment.secret}</code>
              <small>{t('mfa.manualKeyHint')}</small>
            </div>
          </div>
        </div>
      </section>

      <section className="auth-enrollment-section">
        <Field label={t('mfa.totpCode')}>
          {(control) => (
            <div className="auth-input auth-input-code">
              <StudioIcon icon={Smartphone} />
              <input
                {...control}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                minLength={6}
                maxLength={6}
                value={input.totpCode}
                disabled={input.disabled}
                required
                onChange={(event) => input.onTotpCodeChange(
                  event.target.value.replace(/\D/gu, '').slice(0, 6),
                )}
              />
            </div>
          )}
        </Field>
      </section>
    </div>
  );
}
