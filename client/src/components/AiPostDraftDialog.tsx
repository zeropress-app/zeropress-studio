import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AiPostDraftRequest,
  AiPostDraftResponse,
  AiPostDraftTarget,
} from '../../../contracts/ai-post-draft';
import {
  AI_CONTENT_DRAFT_BRIEF_MAX_LENGTH,
  AI_CONTENT_DRAFT_CONTENT_MAX_LENGTH,
  type AiContentDraftCandidate,
  type AiContentDraftLength,
  type AiContentDraftTone,
} from '../../../contracts/ai-content-draft';
import type {
  AiPageDraftPreset,
  AiPageDraftRequest,
  AiPageDraftResponse,
  AiPageDraftTarget,
} from '../../../contracts/ai-page-draft';
import type { ApiErrorCode } from '../../../contracts/api';
import { ContentBodyEditor } from './ContentBodyEditor';
import {
  Button,
  Callout,
  Dialog,
  Field,
  InlineStatus,
  Notice,
} from './primitives';

type FailureKey =
  | 'sourceEmpty'
  | 'authorUnavailable'
  | 'rateLimited'
  | 'unavailable'
  | 'invalidResponse'
  | 'timeout'
  | 'network'
  | 'unexpected';

export type AiContentDraftSelection = {
  title: boolean;
  excerpt: boolean;
  content: boolean;
};
export type AiPostDraftSelection = AiContentDraftSelection;

function apiFailureKey(code: ApiErrorCode): FailureKey {
  switch (code) {
    case 'AI_POST_DRAFT_SOURCE_EMPTY':
    case 'AI_PAGE_DRAFT_SOURCE_EMPTY':
      return 'sourceEmpty';
    case 'POST_AUTHOR_NOT_LINKED':
      return 'authorUnavailable';
    case 'AI_REQUEST_RATE_LIMITED':
      return 'rateLimited';
    case 'AI_POST_DRAFT_RESPONSE_INVALID':
    case 'AI_PAGE_DRAFT_RESPONSE_INVALID':
      return 'invalidResponse';
    case 'AI_SERVICE_UNAVAILABLE':
      return 'unavailable';
    default:
      return 'unexpected';
  }
}

function clientFailureKey(error: unknown): FailureKey {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return 'unexpected';
  }
  const code = (error as { code?: unknown }).code;
  if (code === 'TIMEOUT') return 'timeout';
  if (code === 'NETWORK_ERROR') return 'network';
  return 'invalidResponse';
}

type SharedDialogInput = {
  open: boolean;
  currentTitle: string;
  currentExcerpt: string;
  onApply: (
    candidate: AiContentDraftCandidate,
    selection: AiContentDraftSelection,
  ) => void;
  onClose: () => void;
  onSessionEnded: () => void;
};

type PostDialogInput = SharedDialogInput & {
  kind: 'post';
  target: AiPostDraftTarget;
  generate: (
    request: AiPostDraftRequest,
    signal: AbortSignal,
  ) => Promise<AiPostDraftResponse>;
};

type PageDialogInput = SharedDialogInput & {
  kind: 'page';
  target: AiPageDraftTarget;
  generate: (
    request: AiPageDraftRequest,
    signal: AbortSignal,
  ) => Promise<AiPageDraftResponse>;
};

function AiContentDraftDialog(input: PostDialogInput | PageDialogInput) {
  const { t } = useTranslation(input.kind === 'page' ? 'pages' : 'posts');
  const abortRef = useRef<AbortController | null>(null);
  const [brief, setBrief] = useState('');
  const [tone, setTone] = useState<AiContentDraftTone>('informative');
  const [length, setLength] = useState<AiContentDraftLength>('medium');
  const [preset, setPreset] = useState<AiPageDraftPreset>('general');
  const [candidate, setCandidate] = useState<AiContentDraftCandidate | null>(null);
  const [selection, setSelection] = useState<AiContentDraftSelection>({
    title: false,
    excerpt: false,
    content: true,
  });
  const [generating, setGenerating] = useState(false);
  const [failure, setFailure] = useState<FailureKey | null>(null);

  useEffect(() => {
    if (!input.open) return;
    setBrief('');
    setTone('informative');
    setLength('medium');
    setPreset('general');
    setCandidate(null);
    setSelection({
      title: input.currentTitle.trim() === '',
      excerpt: input.currentExcerpt.trim() === '',
      content: true,
    });
    setFailure(null);
  }, [input.currentExcerpt, input.currentTitle, input.open]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function close() {
    abortRef.current?.abort();
    abortRef.current = null;
    setGenerating(false);
    input.onClose();
  }

  async function generate() {
    if (
      generating
      || (!input.currentTitle.trim() && !brief.trim())
    ) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setCandidate(null);
    setFailure(null);
    try {
      const commonRequest = {
        title: input.currentTitle,
        brief,
        tone,
        length,
        ...input.target,
      };
      const response = input.kind === 'page'
        ? await input.generate({
          ...commonRequest,
          preset,
        } as AiPageDraftRequest, controller.signal)
        : await input.generate(
          commonRequest as AiPostDraftRequest,
          controller.signal,
        );
      if (controller.signal.aborted) return;
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setFailure(apiFailureKey(response.error.code));
        return;
      }
      setSelection({
        title: input.currentTitle.trim() === '',
        excerpt: input.currentExcerpt.trim() === '',
        content: true,
      });
      setCandidate(response.data);
    } catch (error) {
      if (!controller.signal.aborted) setFailure(clientFailureKey(error));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setGenerating(false);
      }
    }
  }

  function toggle(
    key: keyof AiContentDraftSelection,
    event: ChangeEvent<HTMLInputElement>,
  ) {
    setSelection((current) => ({
      ...current,
      [key]: event.target.checked,
    }));
  }

  function apply() {
    if (!candidate || !Object.values(selection).some(Boolean)) return;
    input.onApply(candidate, selection);
    close();
  }

  const sourceAvailable = input.kind === 'page' && preset === 'policy_outline'
    ? Boolean(brief.trim())
    : Boolean(input.currentTitle.trim() || brief.trim());
  const selected = Object.values(selection).some(Boolean);
  return (
    <Dialog
      open={input.open}
      size="wide"
      onClose={close}
      busy={generating}
      kicker={t('aiDraft.kicker')}
      title={t(candidate ? 'aiDraft.reviewTitle' : 'aiDraft.title')}
      description={t(candidate
        ? 'aiDraft.reviewDescription'
        : 'aiDraft.description')}
      actions={candidate ? (
        <>
          <Button type="button" onClick={close}>
            {t('aiDraft.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!selected}
            onClick={apply}
          >
            {t('aiDraft.apply')}
          </Button>
        </>
      ) : (
        <>
          <Button type="button" onClick={close}>
            {t('aiDraft.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={generating || !sourceAvailable}
            onClick={() => void generate()}
          >
            {generating ? t('aiDraft.generating') : t('aiDraft.generate')}
          </Button>
        </>
      )}
    >
      {candidate ? (
        <div className="ai-post-draft-review">
          <Notice tone="warning">
            <p>{t('aiDraft.factCheck')}</p>
          </Notice>
          <div className="ai-post-draft-review-fields">
            <label className="content-editor-checkbox">
              <input
                type="checkbox"
                checked={selection.title}
                onChange={(event) => toggle('title', event)}
              />
              <span className="content-editor-checkbox-label">
                {t(input.currentTitle.trim()
                  ? 'aiDraft.replaceTitle'
                  : 'aiDraft.useTitle')}
              </span>
            </label>
            <Field label={t('aiDraft.generatedTitle')}>
              {(control) => (
                <input
                  {...control}
                  type="text"
                  value={candidate.title}
                  readOnly
                />
              )}
            </Field>
            <label className="content-editor-checkbox">
              <input
                type="checkbox"
                checked={selection.excerpt}
                onChange={(event) => toggle('excerpt', event)}
              />
              <span className="content-editor-checkbox-label">
                {t(input.currentExcerpt.trim()
                  ? 'aiDraft.replaceExcerpt'
                  : 'aiDraft.useExcerpt')}
              </span>
            </label>
            <Field label={t('aiDraft.generatedExcerpt')}>
              {(control) => (
                <textarea
                  {...control}
                  rows={4}
                  value={candidate.excerpt}
                  readOnly
                />
              )}
            </Field>
            <label className="content-editor-checkbox">
              <input
                type="checkbox"
                checked={selection.content}
                onChange={(event) => toggle('content', event)}
              />
              <span className="content-editor-checkbox-label">
                {t('aiDraft.useContent')}
              </span>
            </label>
          </div>
          <section aria-labelledby="ai-post-draft-preview-title">
            <h3
              className="content-revision-subheading"
              id="ai-post-draft-preview-title"
            >
              {t('aiDraft.generatedContent')}
            </h3>
            <div className="ai-post-draft-preview">
              <ContentBodyEditor
                value={candidate.content}
                documentType={candidate.document_type}
                editorMode={candidate.editor_mode}
                editorProfile={candidate.editor_profile}
                maximumLength={AI_CONTENT_DRAFT_CONTENT_MAX_LENGTH}
                disabled
                canonicalClean
                canonicalEditorState={{
                  content: candidate.content,
                  editor_mode: candidate.editor_mode,
                  editor_profile: candidate.editor_profile,
                }}
                canonicalEditorContextClean
                onChange={() => {}}
                onDirty={() => {}}
                onEditorStateChange={() => {}}
                onRequestMedia={() => {}}
              />
            </div>
          </section>
        </div>
      ) : (
        <div className="ai-post-draft-form">
          {input.kind === 'page' ? (
            <Field
              label={t('aiDraft.presetLabel')}
              hint={t(`aiDraft.preset.${preset}.description`)}
            >
              {(control) => (
                <select
                  {...control}
                  value={preset}
                  disabled={generating}
                  onChange={(event) => {
                    setPreset(event.target.value as AiPageDraftPreset);
                    setFailure(null);
                  }}
                >
                  <option value="general">
                    {t('aiDraft.preset.general.label')}
                  </option>
                  <option value="about">
                    {t('aiDraft.preset.about.label')}
                  </option>
                  <option value="landing">
                    {t('aiDraft.preset.landing.label')}
                  </option>
                  <option value="policy_outline">
                    {t('aiDraft.preset.policy_outline.label')}
                  </option>
                </select>
              )}
            </Field>
          ) : null}
          <Field
            label={t('aiDraft.briefLabel')}
            hint={t('aiDraft.briefHint')}
          >
            {(control) => (
              <textarea
                {...control}
                rows={8}
                maxLength={AI_CONTENT_DRAFT_BRIEF_MAX_LENGTH}
                value={brief}
                disabled={generating}
                onChange={(event) => {
                  setBrief(event.target.value);
                  setFailure(null);
                }}
              />
            )}
          </Field>
          <div className="ai-post-draft-options">
            <Field label={t('aiDraft.toneLabel')}>
              {(control) => (
                <select
                  {...control}
                  value={tone}
                  disabled={generating}
                  onChange={(event) => setTone(
                    event.target.value as AiContentDraftTone,
                  )}
                >
                  <option value="informative">
                    {t('aiDraft.tone.informative')}
                  </option>
                  <option value="professional">
                    {t('aiDraft.tone.professional')}
                  </option>
                  <option value="conversational">
                    {t('aiDraft.tone.conversational')}
                  </option>
                </select>
              )}
            </Field>
            <Field label={t('aiDraft.lengthLabel')}>
              {(control) => (
                <select
                  {...control}
                  value={length}
                  disabled={generating}
                  onChange={(event) => setLength(
                    event.target.value as AiContentDraftLength,
                  )}
                >
                  <option value="short">{t('aiDraft.length.short')}</option>
                  <option value="medium">{t('aiDraft.length.medium')}</option>
                  <option value="long">{t('aiDraft.length.long')}</option>
                </select>
              )}
            </Field>
          </div>
          <Callout tone="info">
            <p>{t('aiDraft.noResearch')}</p>
          </Callout>
          {input.kind === 'page' && preset === 'policy_outline' ? (
            <Callout tone="warning">
              <p>{t('aiDraft.policyNotice')}</p>
            </Callout>
          ) : null}
          {generating ? (
            <InlineStatus>{t('aiDraft.generatingDescription')}</InlineStatus>
          ) : null}
          {failure ? (
            <Notice tone="error">
              <p>{t(`aiDraft.errors.${failure}`)}</p>
            </Notice>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}

export function AiPostDraftDialog(
  input: Omit<PostDialogInput, 'kind'>,
) {
  return <AiContentDraftDialog {...input} kind="post" />;
}

export function AiPageDraftDialog(
  input: Omit<PageDialogInput, 'kind'>,
) {
  return <AiContentDraftDialog {...input} kind="page" />;
}
