import { useEffect, useRef, useState } from 'react';
import { Eye, Monitor, Smartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, Notice, StudioIcon } from './primitives';
import type { ContentPreviewRequest, ContentPreviewSource } from '../editor/content-preview';
import '../screens/content-preview.css';

export function ContentPreviewButton(input: { getSource: () => ContentPreviewSource }) {
  const { t, i18n } = useTranslation('contentEditor');
  const [source, setSource] = useState<ContentPreviewRequest | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [mobile, setMobile] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!source) return;
    const controller = new AbortController();
    setResult(null);
    setFailed(false);
    void import('../editor/content-preview-client')
      .then(({ renderContentPreview }) => renderContentPreview(source, controller.signal))
      .then((document) => { if (!controller.signal.aborted) setResult(document); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [source, attempt]);

  return <>
    <Button ref={buttonRef} type="button" onClick={() => {
      setMobile(false);
      setResult(null);
      setFailed(false);
      setSource({
        ...input.getSource(),
        language: i18n.language,
        dark: document.documentElement.dataset.theme === 'dark',
        labels: {
          linkDetails: t('preview.linkDetails'),
          address: t('preview.address'),
          target: t('preview.target'),
          newWindow: t('preview.newWindow'),
          sameWindow: t('preview.sameWindow'),
          embedTitle: t('preview.externalContent'),
          embedUnavailable: t('preview.embeddedContent'),
          missingAddress: t('preview.missingAddress'),
          close: t('preview.close'),
        },
      });
    }}>
      <StudioIcon icon={Eye} className="content-editor-button-icon" />
      {t('preview.open')}
    </Button>
    <Dialog open={source !== null} size="comparison" closeOnBackdrop={false}
      onClose={() => setSource(null)} title={t('preview.title')}
      description={t('preview.description')} returnFocusRef={buttonRef}
      actions={<Button type="button" onClick={() => setSource(null)}>{t('preview.close')}</Button>}
    >
      <div className="content-preview-controls" role="group" aria-label={t('preview.width')}>
        <Button type="button" size="sm" aria-pressed={!mobile} onClick={() => setMobile(false)}>
          <StudioIcon icon={Monitor} />{t('preview.desktop')}
        </Button>
        <Button type="button" size="sm" aria-pressed={mobile} onClick={() => setMobile(true)}>
          <StudioIcon icon={Smartphone} />{t('preview.mobile')}
        </Button>
      </div>
      {failed ? <Notice tone="warning">
        <p>{t('preview.failed')}</p>
        <Button type="button" onClick={() => setAttempt((value) => value + 1)}>{t('retry')}</Button>
      </Notice> : result === null ? <p role="status">{t('preview.loading')}</p> : (
        <div className="content-preview-viewport">
          <iframe className={`content-preview-frame${mobile ? ' is-mobile' : ''}`}
            title={t('preview.title')} sandbox="" referrerPolicy="no-referrer"
            srcDoc={result} tabIndex={0} />
        </div>
      )}
    </Dialog>
  </>;
}
