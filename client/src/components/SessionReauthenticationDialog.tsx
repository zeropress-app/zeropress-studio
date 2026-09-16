import { useTranslation } from 'react-i18next';
import { LoginPage } from '../LoginPage';
import {
  Button,
  Dialog,
  Notice,
  Spinner,
} from './primitives';

export type SessionReauthenticationPhase =
  | 'required'
  | 'refreshing'
  | 'refresh_failed'
  | 'identity_mismatch';

export function SessionReauthenticationDialog(input: {
  phase: SessionReauthenticationPhase;
  email: string;
  accountName: string;
  onAuthenticated: () => void;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslation('auth');
  const retryable = input.phase === 'refresh_failed';

  return (
    <Dialog
      open
      busy={input.phase === 'refreshing'}
      size="wide"
      backdrop="blur"
      kicker={t('reauthentication.kicker')}
      title={t('reauthentication.title')}
      description={t('reauthentication.description', {
        name: input.accountName,
      })}
      onClose={() => undefined}
      actions={input.phase !== 'refreshing' ? (
        <>
          <Button type="button" variant="ghost" onClick={input.onDiscard}>
            {t('reauthentication.discard')}
          </Button>
          {retryable ? (
            <Button type="button" variant="primary" onClick={input.onRetry}>
              {t('reauthentication.retry')}
            </Button>
          ) : null}
        </>
      ) : undefined}
    >
      {input.phase === 'required' ? (
        <LoginPage
          embedded
          emailLocked
          initialEmail={input.email}
          onAuthenticated={input.onAuthenticated}
        />
      ) : null}
      {input.phase === 'refreshing' ? (
        <div className="session-reauthentication-status" role="status">
          <Spinner />
          <span>{t('reauthentication.refreshing')}</span>
        </div>
      ) : null}
      {input.phase === 'refresh_failed' ? (
        <div className="session-reauthentication-status">
          <Notice tone="error">
            {t('reauthentication.refreshFailed')}
          </Notice>
        </div>
      ) : null}
      {input.phase === 'identity_mismatch' ? (
        <div className="session-reauthentication-status">
          <Notice tone="error">
            {t('reauthentication.identityMismatch')}
          </Notice>
        </div>
      ) : null}
    </Dialog>
  );
}
