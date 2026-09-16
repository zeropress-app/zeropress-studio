import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldOff } from 'lucide-react';
import {
  CLOUDFLARE_ACCESS_RECOVERY_CONFIRMATION,
  type CloudflareAccessRecoveryStatus,
} from '../../../contracts/cloudflare-access';
import {
  OperationsClientError,
  requestCloudflareAccessRecovery,
} from '../lib/operations-client';
import { useBusyChange, type BusyChangeHandler } from '../hooks/useBusyChange';
import {
  Button,
  Callout,
  Dialog,
  DialogActions,
  Field,
  Notice,
  Panel,
  StudioIcon,
} from './primitives';

export function CloudflareAccessRecoveryPanel(props: {
  token: string;
  status: CloudflareAccessRecoveryStatus;
  refreshStatus: () => Promise<void>;
  headingLevel?: 2 | 3;
  onBusyChange?: BusyChangeHandler;
}) {
  const { t } = useTranslation('operations');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);
  useBusyChange(props.onBusyChange, busy);

  async function disableRequirement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      busy
      || confirmation !== CLOUDFLARE_ACCESS_RECOVERY_CONFIRMATION
    ) return;

    setBusy(true);
    setMessage(null);
    try {
      const response = await requestCloudflareAccessRecovery({
        token: props.token,
        request: { confirmation: CLOUDFLARE_ACCESS_RECOVERY_CONFIRMATION },
      });
      if (!response.success) {
        setMessage({
          tone: 'error',
          text: t('cloudflareAccessRecovery.errors.api', {
            code: response.error.code,
          }),
        });
        return;
      }
      setDialogOpen(false);
      setConfirmation('');
      setMessage({
        tone: 'success',
        text: t('cloudflareAccessRecovery.completed'),
      });
      await props.refreshStatus();
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof OperationsClientError
          ? t('cloudflareAccessRecovery.errors.client', { code: error.code })
          : t('cloudflareAccessRecovery.errors.unexpected'),
      });
    } finally {
      setBusy(false);
    }
  }

  const tone = props.status.state === 'disabled'
    ? 'success'
    : props.status.state === 'required'
      ? 'warning'
      : 'error';

  return (
    <>
      <Panel
        headingLevel={props.headingLevel ?? 3}
        leading={<StudioIcon icon={ShieldOff} />}
        kicker={t('cloudflareAccessRecovery.level')}
        title={t('cloudflareAccessRecovery.title')}
        description={t('cloudflareAccessRecovery.description')}
      >
        <div className="operations-content-card">
          <Callout
            tone={tone}
            title={t(`cloudflareAccessRecovery.states.${props.status.state}`)}
          >
            {t(`cloudflareAccessRecovery.guidance.${props.status.state}`)}
          </Callout>
          {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
          {props.status.disable_available ? (
            <div className="operations-actions">
              <Button
                type="button"
                variant="danger"
                disabled={busy}
                onClick={() => setDialogOpen(true)}
              >
                <StudioIcon icon={ShieldOff} />
                {t('cloudflareAccessRecovery.action')}
              </Button>
            </div>
          ) : null}
        </div>
      </Panel>

      <Dialog
        open={dialogOpen}
        onClose={() => {
          if (!busy) setDialogOpen(false);
        }}
        busy={busy}
        title={t('cloudflareAccessRecovery.dialog.title')}
        description={t('cloudflareAccessRecovery.dialog.description')}
      >
        <form
          className="operations-dialog-form"
          onSubmit={disableRequirement}
          noValidate
        >
          <Callout tone="warning">
            {t('cloudflareAccessRecovery.dialog.impact')}
          </Callout>
          <Field
            label={t('cloudflareAccessRecovery.confirmation')}
            labelAdornment={(
              <code className="operations-code">
                {CLOUDFLARE_ACCESS_RECOVERY_CONFIRMATION}
              </code>
            )}
          >
            {(control) => (
              <input
                {...control}
                type="text"
                autoComplete="off"
                value={confirmation}
                disabled={busy}
                required
                onChange={(event) => setConfirmation(event.target.value)}
              />
            )}
          </Field>
          <DialogActions>
            <Button
              type="button"
              disabled={busy}
              onClick={() => setDialogOpen(false)}
            >
              {t('confirmation.cancel')}
            </Button>
            <Button
              type="submit"
              variant="danger"
              disabled={
                busy
                || confirmation !== CLOUDFLARE_ACCESS_RECOVERY_CONFIRMATION
              }
            >
              <StudioIcon icon={ShieldOff} />
              {busy
                ? t('cloudflareAccessRecovery.running')
                : t('cloudflareAccessRecovery.execute')}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </>
  );
}
