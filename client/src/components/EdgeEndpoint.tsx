import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Link2 } from 'lucide-react';
import { edgeEndpoint } from '../../../contracts/edge-url';
import { useEdgeUrl } from '../hooks/useEdgeUrl';
import { STUDIO_PATHS } from '../routing/studio-routes';
import { Button, ButtonLink, Field, InlineStatus, Notice, StudioIcon } from './primitives';

export function EdgeEndpoint(input: {
  kind: 'comments' | 'form' | 'newsletter';
  slug?: string;
  onSessionEnded: () => void;
}) {
  const { t } = useTranslation('edgeServices');
  const state = useEdgeUrl(input.onSessionEnded);
  const [copied, setCopied] = useState<'copied' | 'copyFailed' | null>(null);
  const endpoint = edgeEndpoint(
    state.document?.settings.edge_origin ?? '', input.kind, input.slug,
  );
  useEffect(() => { setCopied(null); }, [endpoint]);

  async function copy(config: boolean) {
    if (!endpoint) return;
    try {
      const text = config
        ? JSON.stringify({ [`${input.kind}_endpoint`]: endpoint }, null, 2) + '\n'
        : endpoint;
      await navigator.clipboard.writeText(text);
      setCopied('copied');
    } catch {
      setCopied('copyFailed');
    }
  }

  if (state.failed) return (
    <Notice tone="error" actions={(
      <Button type="button" onClick={state.retry}>{t('actions.retry')}</Button>
    )}>{t('url.loadFailed')}</Notice>
  );
  if (!state.document) return <InlineStatus>{t('loading')}</InlineStatus>;
  return (
    <div className="settings-fields">
      {endpoint ? <>
        <Field
          label={t(`url.endpoint.${input.kind}`)}
          hint={input.kind === 'comments'
            ? t('url.commentsHint')
            : t('url.configHint', { key: `${input.kind}_endpoint` })}
          leading={<StudioIcon icon={Link2} />}
        >
          {(control) => (
            <input {...control} className="studio-field-input" readOnly
              value={endpoint} onFocus={(event) => event.target.select()} />
          )}
        </Field>
        <div className="settings-action-row">
          <Button type="button" onClick={() => void copy(false)}>
            <StudioIcon icon={Copy} />{t('url.copy')}
          </Button>
          {input.kind !== 'comments' ? (
            <Button type="button" onClick={() => void copy(true)}>
              <StudioIcon icon={Copy} />{t('url.copyConfig')}
            </Button>
          ) : null}
        </div>
        {copied ? <InlineStatus>{t(`url.${copied}`)}</InlineStatus> : null}
      </> : <Notice tone="info">{t('url.missing')}</Notice>}
      <div>
        <ButtonLink to={`${STUDIO_PATHS.edgeServicesSettings}#edge-url`}>
          <StudioIcon icon={Link2} />{t('url.configure')}
        </ButtonLink>
      </div>
    </div>
  );
}
