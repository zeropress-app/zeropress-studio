import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AI_POST_EDIT_INSTRUCTION_MAX_LENGTH,
  AI_POST_EDIT_SELECTION_MAX_LENGTH,
  type AiPostEditRequest,
  type AiPostEditResponse,
  type AiPostEditTarget,
  type AiPostEditTone,
} from '../../../contracts/ai-post-edit';
import {
  POST_CONTENT_MAX_LENGTH,
} from '../../../contracts/posts';
import type { ApiErrorCode } from '../../../contracts/api';
import type { ContentAiSelection } from '../editor/content-ai-selection';
import { classifyTiptapHtml } from '../editor/tiptap-compatibility';
import { AiPostEditComparison } from './AiPostEditComparison';
import {
  Button,
  Callout,
  Dialog,
  Field,
  InlineStatus,
  Notice,
} from './primitives';

type FailureKey =
  | 'selectionEmpty'
  | 'selectionUnsupported'
  | 'stale'
  | 'authorUnavailable'
  | 'rateLimited'
  | 'unavailable'
  | 'invalidResponse'
  | 'timeout'
  | 'network'
  | 'unexpected';

function apiFailureKey(code: ApiErrorCode): FailureKey {
  switch (code) {
    case 'AI_POST_EDIT_SELECTION_EMPTY':
      return 'selectionEmpty';
    case 'AI_POST_EDIT_SELECTION_UNSUPPORTED':
      return 'selectionUnsupported';
    case 'AI_POST_EDIT_UNAVAILABLE':
    case 'POST_REVISION_CONFLICT':
      return 'stale';
    case 'POST_AUTHOR_NOT_LINKED':
      return 'authorUnavailable';
    case 'AI_REQUEST_RATE_LIMITED':
      return 'rateLimited';
    case 'AI_POST_EDIT_RESPONSE_INVALID':
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

function validateReviewedContent(input: {
  content: string;
  target: AiPostEditTarget;
}): { valid: true; content: string } | { valid: false } {
  if (input.content.length > POST_CONTENT_MAX_LENGTH) return { valid: false };
  if (
    input.target.document_type === 'html'
    && input.target.editor_mode === 'visual'
  ) {
    const result = classifyTiptapHtml(input.content);
    if (
      result.classification !== 'safe'
      || result.normalized
      || result.canonicalHtml !== input.content
    ) return { valid: false };
    return { valid: true, content: result.canonicalHtml };
  }
  return { valid: true, content: input.content };
}

export function AiPostEditDialog(input: {
  open: boolean;
  expectedRevision: string;
  target: AiPostEditTarget;
  selection: ContentAiSelection;
  generate: (
    request: AiPostEditRequest,
    signal: AbortSignal,
  ) => Promise<AiPostEditResponse>;
  composeCandidate: (
    selection: ContentAiSelection,
    replacement: string,
  ) => string | null;
  onApply: (content: string) => void;
  onClose: () => void;
  onSessionEnded: () => void;
}) {
  const { t } = useTranslation('posts');
  const abortRef = useRef<AbortController | null>(null);
  const [operation, setOperation] = useState<'expand' | 'rewrite'>('rewrite');
  const [instruction, setInstruction] = useState('');
  const [tone, setTone] = useState<AiPostEditTone>('preserve');
  const [generating, setGenerating] = useState(false);
  const [failure, setFailure] = useState<FailureKey | null>(null);
  const [proposal, setProposal] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<string | null>(null);
  const [resetEpoch, setResetEpoch] = useState(0);

  useEffect(() => {
    if (!input.open) return;
    setOperation('rewrite');
    setInstruction('');
    setTone('preserve');
    setGenerating(false);
    setFailure(null);
    setProposal(null);
    setReviewed(null);
    setResetEpoch(0);
  }, [input.open, input.selection]);

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
      || input.selection.selectedContent.length > AI_POST_EDIT_SELECTION_MAX_LENGTH
      || (operation === 'expand' && instruction.trim() === '')
    ) return;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setGenerating(true);
    setFailure(null);
    setProposal(null);
    setReviewed(null);
    try {
      const response = await input.generate({
        expected_revision: input.expectedRevision,
        operation,
        instruction,
        tone,
        target: input.target,
        selection: {
          kind: input.selection.selectionKind,
          source: input.selection.selectedContent,
          context_before: input.selection.contextBefore,
          context_after: input.selection.contextAfter,
        },
      }, controller.signal);
      if (controller.signal.aborted) return;
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setFailure(apiFailureKey(response.error.code));
        return;
      }
      const candidate = input.composeCandidate(
        input.selection,
        response.data.replacement,
      );
      if (candidate === null) {
        setFailure('stale');
        return;
      }
      const validation = validateReviewedContent({
        content: candidate,
        target: input.target,
      });
      if (!validation.valid) {
        setFailure('invalidResponse');
        return;
      }
      setProposal(validation.content);
      setReviewed(validation.content);
      setResetEpoch((value) => value + 1);
    } catch (error) {
      if (!controller.signal.aborted) setFailure(clientFailureKey(error));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setGenerating(false);
      }
    }
  }

  function resetReview(value: string) {
    setReviewed(value);
    setFailure(null);
    setResetEpoch((current) => current + 1);
  }

  function apply() {
    if (reviewed === null || reviewed === input.selection.baseContent) return;
    const validation = validateReviewedContent({
      content: reviewed,
      target: input.target,
    });
    if (!validation.valid) {
      setFailure('invalidResponse');
      return;
    }
    input.onApply(validation.content);
    close();
  }

  const reviewValidation = reviewed === null
    ? null
    : validateReviewedContent({ content: reviewed, target: input.target });
  const canApply = reviewValidation?.valid === true
    && reviewed !== input.selection.baseContent;
  const canGenerate = !generating
    && input.selection.selectedContent.length <= AI_POST_EDIT_SELECTION_MAX_LENGTH
    && (operation !== 'expand' || instruction.trim() !== '');

  return (
    <Dialog
      open={input.open}
      size="wide"
      onClose={close}
      busy={generating}
      kicker={t('aiEdit.kicker')}
      title={t(proposal ? 'aiEdit.reviewTitle' : 'aiEdit.title')}
      description={t(proposal
        ? 'aiEdit.reviewDescription'
        : 'aiEdit.description')}
      actions={proposal && reviewed !== null ? (
        <>
          <Button type="button" onClick={close}>
            {t('aiEdit.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!canApply}
            onClick={apply}
          >
            {t('aiEdit.apply')}
          </Button>
        </>
      ) : (
        <>
          <Button type="button" onClick={close}>
            {t('aiEdit.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!canGenerate}
            onClick={() => void generate()}
          >
            {generating ? t('aiEdit.generating') : t('aiEdit.generate')}
          </Button>
        </>
      )}
    >
      {proposal && reviewed !== null ? (
        <div className="ai-post-edit-review">
          <Notice tone="warning">{t('aiEdit.reviewWarning')}</Notice>
          <div className="ai-post-edit-review-actions">
            <Button
              type="button"
              size="sm"
              onClick={() => resetReview(proposal)}
            >
              {t('aiEdit.restoreProposal')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => resetReview(input.selection.baseContent)}
            >
              {t('aiEdit.restoreOriginal')}
            </Button>
          </div>
          <AiPostEditComparison
            original={input.selection.baseContent}
            modified={reviewed}
            documentType={input.target.document_type}
            resetEpoch={resetEpoch}
            copy={{
              comparisonLabel: t('aiEdit.diffLabel'),
              originalLabel: t('aiEdit.originalLabel'),
              modifiedLabel: t('aiEdit.modifiedLabel'),
              loading: t('aiEdit.diffLoading'),
              unavailable: t('aiEdit.diffUnavailable'),
              retry: t('aiEdit.diffRetry'),
            }}
            onChange={(value) => {
              setReviewed(value);
              setFailure(null);
            }}
          />
          {reviewValidation && !reviewValidation.valid ? (
            <Notice tone="error">{t('aiEdit.reviewInvalid')}</Notice>
          ) : null}
          {failure ? (
            <Notice tone="error">{t(`aiEdit.errors.${failure}`)}</Notice>
          ) : null}
        </div>
      ) : (
        <div className="ai-post-draft-form">
          <Field label={t('aiEdit.selectionLabel')}>
            {(control) => (
              <textarea
                {...control}
                rows={6}
                readOnly
                value={input.selection.selectedContent}
              />
            )}
          </Field>
          <Field label={t('aiEdit.operationLabel')}>
            {(control) => (
              <select
                {...control}
                value={operation}
                disabled={generating}
                onChange={(event) => {
                  setOperation(event.target.value as 'expand' | 'rewrite');
                  setFailure(null);
                }}
              >
                <option value="rewrite">{t('aiEdit.operation.rewrite')}</option>
                <option value="expand">{t('aiEdit.operation.expand')}</option>
              </select>
            )}
          </Field>
          <Field
            label={t('aiEdit.instructionLabel')}
            hint={t(operation === 'expand'
              ? 'aiEdit.expandInstructionHint'
              : 'aiEdit.rewriteInstructionHint')}
          >
            {(control) => (
              <textarea
                {...control}
                rows={5}
                maxLength={AI_POST_EDIT_INSTRUCTION_MAX_LENGTH}
                value={instruction}
                disabled={generating}
                onChange={(event) => {
                  setInstruction(event.target.value);
                  setFailure(null);
                }}
              />
            )}
          </Field>
          <Field label={t('aiEdit.toneLabel')}>
            {(control) => (
              <select
                {...control}
                value={tone}
                disabled={generating}
                onChange={(event) => setTone(
                  event.target.value as AiPostEditTone,
                )}
              >
                <option value="preserve">{t('aiEdit.tone.preserve')}</option>
                <option value="informative">{t('aiEdit.tone.informative')}</option>
                <option value="professional">{t('aiEdit.tone.professional')}</option>
                <option value="conversational">{t('aiEdit.tone.conversational')}</option>
              </select>
            )}
          </Field>
          <Callout tone="info"><p>{t('aiEdit.noResearch')}</p></Callout>
          <Callout tone="warning"><p>{t('aiEdit.protectedContent')}</p></Callout>
          {input.selection.selectedContent.length > AI_POST_EDIT_SELECTION_MAX_LENGTH ? (
            <Notice tone="error">{t('aiEdit.selectionTooLarge')}</Notice>
          ) : null}
          {generating ? (
            <InlineStatus>{t('aiEdit.generatingDescription')}</InlineStatus>
          ) : null}
          {failure ? (
            <Notice tone="error">{t(`aiEdit.errors.${failure}`)}</Notice>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
