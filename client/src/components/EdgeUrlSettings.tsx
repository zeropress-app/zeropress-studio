import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import { Link2, RefreshCw, Save } from 'lucide-react';
import { normalizeEdgeOrigin } from '../../../contracts/edge-url';
import { useEdgeUrl } from '../hooks/useEdgeUrl';
import { requestUpdateEdgeUrlSettings } from '../lib/edge-url-client';
import { Button, Field, InlineStatus, Notice, Panel, StudioIcon } from './primitives';
import { UnsavedChangesGuard } from './UnsavedChangesGuard';

export function EdgeUrlSettings(input: {
  csrfToken: string;
  onSessionEnded: () => void;
}) {
  const { t } = useTranslation('edgeServices');
  const { t: settingsText } = useTranslation('settings');
  const { hash } = useLocation();
  const fieldRef = useRef<HTMLInputElement>(null);
  const state = useEdgeUrl(input.onSessionEnded);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<'saved' | 'failed' | 'conflict' | null>(null);

  useEffect(() => {
    if (state.document && hash === '#edge-url') fieldRef.current?.focus();
  }, [hash, Boolean(state.document)]);

  const value = draft ?? state.document?.settings.edge_origin ?? '';
  const origin = normalizeEdgeOrigin(value);
  const dirty = Boolean(state.document && value !== state.document.settings.edge_origin);

  async function save() {
    if (!state.document || origin === null || saving || result === 'conflict') return;
    setSaving(true);
    setResult(null);
    try {
      const response = await requestUpdateEdgeUrlSettings(input.csrfToken, {
        settings: { edge_origin: origin },
        expected_revision: state.document.revision,
      });
      if (response.success) {
        state.setDocument(response.data);
        setDraft(null);
        setResult('saved');
      } else if (response.error.code === 'AUTHENTICATION_REQUIRED') {
        input.onSessionEnded();
      } else {
        setResult(response.error.code === 'SETTINGS_REVISION_CONFLICT' ? 'conflict' : 'failed');
      }
    } catch {
      setResult('failed');
    } finally {
      setSaving(false);
    }
  }

  function reload() {
    setDraft(null);
    setResult(null);
    state.retry();
  }

  return (
    <section id="edge-url">
      <Panel
        title={t('url.title')}
        description={t('url.description')}
        leading={<StudioIcon icon={Link2} />}
      >
        {state.failed ? (
          <Notice tone="error" actions={(
            <Button type="button" onClick={reload}>
              <StudioIcon icon={RefreshCw} />{t('actions.retry')}
            </Button>
          )}>{t('url.loadFailed')}</Notice>
        ) : !state.document ? (
          <InlineStatus>{t('loading')}</InlineStatus>
        ) : (
          <form className="settings-fields" onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}>
            <Field label={t('url.title')} hint={t('url.hint')}
              error={origin === null ? t('url.invalid') : undefined}>
              {(control) => (
                <input
                  {...control}
                  ref={fieldRef}
                  className="studio-field-input"
                  type="url"
                  value={value}
                  placeholder="https://edge.example.com"
                  disabled={saving}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    if (result !== 'conflict') setResult(null);
                  }}
                />
              )}
            </Field>
            {result ? (
              <Notice tone={result === 'saved' ? 'success' : 'error'}>
                {t(`url.${result}`)}
              </Notice>
            ) : null}
            <div className="settings-action-row">
              {result === 'conflict' ? (
                <Button type="button" onClick={reload}>{t('url.reload')}</Button>
              ) : null}
              <Button type="submit" variant="primary"
                disabled={!dirty || saving || origin === null || result === 'conflict'}>
                <StudioIcon icon={Save} />{t(saving ? 'url.saving' : 'url.save')}
              </Button>
            </div>
          </form>
        )}
      </Panel>
      <UnsavedChangesGuard active={dirty || saving} busy={saving} copy={{
        kicker: settingsText('shared.discard.kicker'),
        title: settingsText(saving ? 'shared.discard.savingTitle' : 'shared.discard.title'),
        description: settingsText(saving ? 'shared.discard.savingDescription' : 'shared.discard.description'),
        stay: settingsText('shared.discard.stay'),
        leave: settingsText('shared.discard.leave'),
      }} />
    </section>
  );
}
