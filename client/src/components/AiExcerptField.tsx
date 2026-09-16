import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AiExcerptRequest,
  AiExcerptResponse,
} from '../../../contracts/ai-excerpt';
import {
  Button,
  Dialog,
  Field,
  Notice,
} from './primitives';

type FailureKey =
  | 'sourceEmpty'
  | 'rateLimited'
  | 'unavailable'
  | 'invalidResponse'
  | 'timeout'
  | 'network'
  | 'unexpected';

type Candidate = {
  excerpt: string;
  sourceTruncated: boolean;
};

function clientFailureKey(error: unknown): FailureKey {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return 'unexpected';
  }
  const code = (error as { code?: unknown }).code;
  if (code === 'TIMEOUT') return 'timeout';
  if (code === 'NETWORK_ERROR') return 'network';
  return 'invalidResponse';
}

function apiFailureKey(response: Extract<
  AiExcerptResponse,
  { success: false }
>): FailureKey {
  switch (response.error.code) {
    case 'AI_EXCERPT_SOURCE_EMPTY':
      return 'sourceEmpty';
    case 'AI_REQUEST_RATE_LIMITED':
      return 'rateLimited';
    case 'AI_EXCERPT_RESPONSE_INVALID':
      return 'invalidResponse';
    case 'AI_SERVICE_UNAVAILABLE':
      return 'unavailable';
    default:
      return 'unexpected';
  }
}

export function AiExcerptField(input: {
  label: string;
  hint: string;
  value: string;
  disabled?: boolean;
  getSource: () => AiExcerptRequest;
  generate: (
    request: AiExcerptRequest,
    signal: AbortSignal,
  ) => Promise<AiExcerptResponse>;
  onChange: (value: string) => void;
  onSessionEnded: () => void;
}) {
  const { t } = useTranslation('contentEditor');
  const abortRef = useRef<AbortController | null>(null);
  const [generating, setGenerating] = useState(false);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [failure, setFailure] = useState<FailureKey | null>(null);
  const [applied, setApplied] = useState(false);

  useEffect(() => () => {
    const controller = abortRef.current;
    abortRef.current = null;
    controller?.abort();
  }, []);

  async function generate() {
    if (generating || input.disabled) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setFailure(null);
    setApplied(false);
    try {
      const response = await input.generate(input.getSource(), controller.signal);
      if (controller.signal.aborted) return;
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setFailure(apiFailureKey(response));
        return;
      }
      setCandidate({
        excerpt: response.data.excerpt,
        sourceTruncated: response.data.source_truncated,
      });
    } catch (error) {
      if (!controller.signal.aborted) setFailure(clientFailureKey(error));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setGenerating(false);
      }
    }
  }

  function changeExcerpt(event: ChangeEvent<HTMLTextAreaElement>) {
    setFailure(null);
    setApplied(false);
    input.onChange(event.target.value);
  }

  function applyCandidate() {
    if (!candidate) return;
    input.onChange(candidate.excerpt);
    setCandidate(null);
    setFailure(null);
    setApplied(true);
  }

  return (
    <>
      <Field
        label={input.label}
        hint={input.hint}
        labelAdornment={(
          <Button
            type="button"
            size="sm"
            disabled={input.disabled || generating}
            onClick={generate}
          >
            {generating
              ? t('aiExcerpt.generating')
              : t('aiExcerpt.generate')}
          </Button>
        )}
      >
        {(control) => (
          <textarea
            {...control}
            rows={4}
            maxLength={500}
            value={input.value}
            disabled={input.disabled}
            onChange={changeExcerpt}
          />
        )}
      </Field>

      {failure ? (
        <Notice tone="error">
          <p>{t(`aiExcerpt.errors.${failure}`)}</p>
        </Notice>
      ) : null}
      {applied ? (
        <Notice tone="success">
          <p>{t('aiExcerpt.applied')}</p>
        </Notice>
      ) : null}

      <Dialog
        open={candidate !== null}
        onClose={() => setCandidate(null)}
        kicker={t('aiExcerpt.reviewKicker')}
        title={t(input.value.trim()
          ? 'aiExcerpt.reviewReplaceTitle'
          : 'aiExcerpt.reviewUseTitle')}
        description={t('aiExcerpt.reviewDescription')}
        actions={(
          <>
            <Button
              type="button"
              onClick={() => setCandidate(null)}
            >
              {t('aiExcerpt.cancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={applyCandidate}
            >
              {t('aiExcerpt.apply')}
            </Button>
          </>
        )}
      >
        <div className="content-editor-fields">
          {input.value.trim() ? (
            <Field label={t('aiExcerpt.currentLabel')}>
              {(control) => (
                <textarea
                  {...control}
                  rows={4}
                  value={input.value}
                  readOnly
                />
              )}
            </Field>
          ) : null}
          <Field label={t('aiExcerpt.generatedLabel')}>
            {(control) => (
              <textarea
                {...control}
                rows={4}
                value={candidate?.excerpt ?? ''}
                readOnly
              />
            )}
          </Field>
          {candidate?.sourceTruncated ? (
            <Notice tone="warning">
              <p>{t('aiExcerpt.sourceTruncated')}</p>
            </Notice>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
