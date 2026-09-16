import {
  Component,
  Suspense,
  forwardRef,
  lazy,
  useImperativeHandle,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ContentEditorMode,
  ContentEditorProfile,
} from '../../../contracts/content-editor';
import type { Media } from '../../../contracts/media';
import {
  classifyTiptapHtml,
  type TiptapCompatibilityResult,
} from '../editor/tiptap-compatibility';
import { formatTiptapVisualHtml } from '../editor/tiptap-html-serialization';
import {
  createContentMediaSnippet,
  insertTextAtSelection,
} from '../lib/content-media-insertion';
import { Button, Dialog, Field, Notice, Spinner } from './primitives';
import { RevisionSourceComparison } from './RevisionSourceComparison';
import type { MonacoSourceEditorHandle } from './MonacoSourceEditor';
import type { TiptapVisualEditorHandle } from './TiptapVisualEditor';
import type {
  ContentAiSelection,
  SourceContentAiSelection,
} from '../editor/content-ai-selection';

const LazyMonacoSourceEditor = lazy(async () => {
  const module = await import('./MonacoSourceEditor');
  return { default: module.MonacoSourceEditor };
});

const LazyTiptapVisualEditor = lazy(async () => {
  const module = await import('./TiptapVisualEditor');
  return { default: module.TiptapVisualEditor };
});

export type ContentBodyEditorHandle = {
  flush: () => string;
  insertMedia: (media: Media) => boolean;
  replaceSelectedImage: (media: Media) => boolean;
  focus: () => void;
  captureAiSelection: () => ContentAiSelection | null;
  buildAiCandidate: (
    selection: ContentAiSelection,
    replacement: string,
  ) => string | null;
};

class ContentEditorErrorBoundary extends Component<{
  resetKey: number;
  fallback: ReactNode;
  children: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // The retryable UI is intentionally local; no content or mode is changed.
  }

  componentDidUpdate(previous: Readonly<{ resetKey: number }>) {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

type Transition =
  | { kind: 'source'; content: string }
  | {
      kind: 'visual';
      result: Extract<TiptapCompatibilityResult, {
        classification: 'safe' | 'review_required';
      }>;
    }
  | {
      kind: 'incompatible';
      result: Extract<TiptapCompatibilityResult, { classification: 'blocked' }>;
    };

type CanonicalEditorState = {
  content: string;
  editor_mode: ContentEditorMode;
  editor_profile: ContentEditorProfile;
};

export const ContentBodyEditor = forwardRef<ContentBodyEditorHandle, {
  value: string;
  documentType: 'html' | 'markdown' | 'plaintext';
  editorMode: ContentEditorMode;
  editorProfile: ContentEditorProfile;
  maximumLength: number;
  disabled?: boolean;
  canonicalClean: boolean;
  canonicalEditorState: CanonicalEditorState | null;
  canonicalEditorContextClean: boolean;
  onChange: (value: string) => void;
  onDirty: () => void;
  onEditorStateChange: (input: {
    content: string;
    editor_mode: ContentEditorMode;
    editor_profile: ContentEditorProfile;
  }) => void;
  onRequestMedia: (mode: 'insert' | 'replace-image') => void;
}>(function ContentBodyEditor(input, ref) {
  const { t } = useTranslation('contentEditor');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sourceRef = useRef<MonacoSourceEditorHandle>(null);
  const visualRef = useRef<TiptapVisualEditorHandle>(null);
  const selectionRef = useRef({ start: 0, end: 0 });
  const [transition, setTransition] = useState<Transition | null>(null);
  const [modeNotice, setModeNotice] = useState(false);
  const [sourceLimitRejected, setSourceLimitRejected] = useState(false);
  const [sourceRetry, setSourceRetry] = useState(0);
  const [sourceRuntimeUnavailable, setSourceRuntimeUnavailable] = useState(false);
  const [visualRetry, setVisualRetry] = useState(0);

  function captureSelection() {
    const textarea = textareaRef.current;
    if (!textarea) return;
    selectionRef.current = {
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
    };
  }

  function insertSourceMedia(media: Media): boolean {
    const insertion = insertTextAtSelection({
      value: input.value,
      insertion: createContentMediaSnippet(media, input.documentType),
      selectionStart: selectionRef.current.start,
      selectionEnd: selectionRef.current.end,
    });
    if (insertion.value.length > input.maximumLength) {
      setSourceLimitRejected(true);
      return false;
    }
    setSourceLimitRejected(false);
    input.onChange(insertion.value);
    window.setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(insertion.cursor, insertion.cursor);
      selectionRef.current = { start: insertion.cursor, end: insertion.cursor };
    }, 0);
    return true;
  }

  function sourceSelection(): SourceContentAiSelection | null {
    const range = sourceRef.current?.getSelectionRange() ?? selectionRef.current;
    if (!range || range.start === range.end) return null;
    const baseContent = sourceRef.current?.flush() ?? input.value;
    const selectedContent = baseContent.slice(range.start, range.end);
    if (!selectedContent.trim()) return null;
    return {
      kind: 'source',
      selectionKind: 'source',
      baseContent,
      selectedContent,
      contextBefore: Array.from(baseContent.slice(0, range.start))
        .slice(-2_000)
        .join(''),
      contextAfter: Array.from(baseContent.slice(range.end))
        .slice(0, 2_000)
        .join(''),
      start: range.start,
      end: range.end,
    };
  }

  useImperativeHandle(ref, () => ({
    flush: () => input.editorMode === 'visual'
      ? visualRef.current?.flush() ?? input.value
      : sourceRef.current?.flush() ?? input.value,
    insertMedia: (media) => input.editorMode === 'visual'
      ? visualRef.current?.insertMedia(media) ?? false
      : sourceRef.current?.insertText(
        createContentMediaSnippet(media, input.documentType),
      ) ?? insertSourceMedia(media),
    replaceSelectedImage: (media) => input.editorMode === 'visual'
      ? visualRef.current?.replaceSelectedImage(media) ?? false
      : false,
    focus: () => input.editorMode === 'visual'
      ? visualRef.current?.focus()
      : sourceRef.current?.focus() ?? textareaRef.current?.focus(),
    captureAiSelection: () => input.editorMode === 'visual'
      ? visualRef.current?.captureAiSelection() ?? null
      : sourceSelection(),
    buildAiCandidate: (selection, replacement) => {
      if (selection.kind === 'visual') {
        return visualRef.current?.buildAiCandidate(selection, replacement)
          ?? null;
      }
      const current = sourceRef.current?.flush() ?? input.value;
      if (current !== selection.baseContent) return null;
      return current.slice(0, selection.start)
        + replacement
        + current.slice(selection.end);
    },
  }));

  function requestMode(next: ContentEditorMode) {
    setModeNotice(false);
    if (next === input.editorMode) return;
    const canonical = input.canonicalEditorState;
    if (
      canonical
      && input.canonicalEditorContextClean
      && next === canonical.editor_mode
    ) {
      const reversesVisualToSource = canonical.editor_mode === 'visual'
        && canonical.editor_profile === 'tiptap-v1'
        && input.editorMode === 'source'
        && input.editorProfile === null
        && input.value === formatTiptapVisualHtml(canonical.content);
      const canonicalVisual = canonical.editor_mode === 'source'
        && canonical.editor_profile === null
        && input.editorMode === 'visual'
        && input.editorProfile === 'tiptap-v1'
        ? classifyTiptapHtml(canonical.content)
        : null;
      const reversesSourceToVisual = canonicalVisual !== null
        && canonicalVisual.classification !== 'blocked'
        && input.value === canonicalVisual.canonicalHtml;
      if (reversesVisualToSource || reversesSourceToVisual) {
        input.onEditorStateChange(canonical);
        return;
      }
    }
    if (!input.canonicalClean) {
      setModeNotice(true);
      return;
    }
    if (next === 'source') {
      setTransition({
        kind: 'source',
        content: formatTiptapVisualHtml(input.value),
      });
      return;
    }
    const result = classifyTiptapHtml(input.value);
    setTransition(result.classification === 'blocked'
      ? { kind: 'incompatible', result }
      : { kind: 'visual', result });
  }

  function confirmTransition() {
    if (!transition || transition.kind === 'incompatible') return;
    input.onEditorStateChange(transition.kind === 'source'
      ? {
          content: transition.content,
          editor_mode: 'source',
          editor_profile: null,
        }
      : {
          content: transition.result.canonicalHtml,
          editor_mode: 'visual',
          editor_profile: 'tiptap-v1',
        });
    setTransition(null);
  }

  const visual = input.documentType === 'html' && input.editorMode === 'visual';
  const reviewRequired = transition?.kind === 'visual'
    && transition.result.classification === 'review_required';
  return (
    <div className="content-body-editor">
      {input.documentType === 'html' ? (
        <div className="content-editor-mode-selector" aria-label={t('contentLabel')}>
          <div className="content-editor-mode-buttons">
            <Button
              type="button"
              size="sm"
              variant={visual ? 'secondary' : 'primary'}
              aria-pressed={!visual}
              data-current={!visual ? 'true' : undefined}
              disabled={input.disabled || !visual}
              onClick={() => requestMode('source')}
            >
              {t('sourceMode')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={visual ? 'primary' : 'secondary'}
              aria-pressed={visual}
              data-current={visual ? 'true' : undefined}
              disabled={input.disabled || visual}
              onClick={() => requestMode('visual')}
            >
              {t('visualMode')}
            </Button>
          </div>
          <small className="content-editor-mode-description">
            {t(visual ? 'visualModeDescription' : 'sourceModeDescription')}
          </small>
        </div>
      ) : null}
      {modeNotice ? <Notice tone="info">{t('saveBeforeModeChange')}</Notice> : null}
      {visual ? (
        <ContentEditorErrorBoundary
          resetKey={visualRetry}
          fallback={(
            <Notice
              tone="error"
              title={t('loadFailedTitle')}
              actions={(
                <Button type="button" onClick={() => setVisualRetry((value) => value + 1)}>
                  {t('retry')}
                </Button>
              )}
            >
              {t('loadFailedDescription')}
            </Notice>
          )}
        >
          <Suspense fallback={(
            <div className="content-editor-loading" role="status">
              <Spinner />
              <span>{t('loading')}</span>
            </div>
          )}>
            <LazyTiptapVisualEditor
              key={visualRetry}
              ref={visualRef}
              content={input.value}
              disabled={input.disabled}
              onChange={input.onChange}
              onDirty={input.onDirty}
              onRequestMedia={input.onRequestMedia}
            />
          </Suspense>
        </ContentEditorErrorBoundary>
      ) : (
        <Field label={t('contentLabel')}>
          {(control) => {
            const fallback = (
              <div className="content-editor-source-fallback">
                <Notice
                  tone="warning"
                  title={t('sourceLoadFailedTitle')}
                  actions={(
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        setSourceRuntimeUnavailable(false);
                        setSourceRetry((value) => value + 1);
                      }}
                    >
                      {t('sourceRetry')}
                    </Button>
                  )}
                >
                  {t('sourceLoadFailedDescription')}
                </Notice>
                <textarea
                  {...control}
                  ref={textareaRef}
                  className="content-editor-source"
                  rows={18}
                  maxLength={input.maximumLength}
                  value={input.value}
                  disabled={input.disabled}
                  onSelect={captureSelection}
                  onClick={captureSelection}
                  onKeyUp={captureSelection}
                  onChange={(event) => {
                    captureSelection();
                    setSourceLimitRejected(false);
                    input.onChange(event.target.value);
                  }}
                />
              </div>
            );
            return (
              <>
                {sourceLimitRejected ? (
                  <Notice tone="warning">{t('sourceLimitRejected')}</Notice>
                ) : null}
                {sourceRuntimeUnavailable ? fallback : (
                  <ContentEditorErrorBoundary
                    resetKey={sourceRetry}
                    fallback={fallback}
                  >
                    <Suspense fallback={(
                      <div className="content-editor-source-loading" role="status">
                        <span className="content-editor-source-loading-inner">
                          <Spinner />
                          {t('sourceLoading')}
                        </span>
                      </div>
                    )}>
                      <LazyMonacoSourceEditor
                        key={sourceRetry}
                        ref={sourceRef}
                        id={control.id}
                        describedBy={control['aria-describedby']}
                        invalid={control['aria-invalid']}
                        value={input.value}
                        documentType={input.documentType}
                        maximumLength={input.maximumLength}
                        disabled={Boolean(input.disabled)}
                        label={t('contentLabel')}
                        onChange={(value) => {
                          setSourceLimitRejected(false);
                          input.onChange(value);
                        }}
                        onLimitExceeded={() => setSourceLimitRejected(true)}
                        onUnavailable={() => setSourceRuntimeUnavailable(true)}
                      />
                    </Suspense>
                  </ContentEditorErrorBoundary>
                )}
              </>
            );
          }}
        </Field>
      )}
      <Dialog
        open={transition !== null}
        size={transition?.kind === 'visual' && transition.result.normalized
          ? 'wide'
          : undefined}
        onClose={() => setTransition(null)}
        title={t(transition?.kind === 'source'
          ? 'switchToSource.title'
          : transition?.kind === 'incompatible'
            ? 'incompatible.title'
            : reviewRequired
              ? 'reviewRequired.title'
              : 'switchToVisual.title')}
        description={t(transition?.kind === 'source'
          ? 'switchToSource.description'
          : transition?.kind === 'incompatible'
            ? 'incompatible.description'
            : reviewRequired
              ? 'reviewRequired.description'
              : 'switchToVisual.description')}
        actions={transition?.kind === 'incompatible' ? (
          <Button type="button" onClick={() => setTransition(null)}>
            {t('incompatible.close')}
          </Button>
        ) : (
          <>
            <Button type="button" variant="ghost" onClick={() => setTransition(null)}>
              {t('linkDialog.cancel')}
            </Button>
            <Button type="button" variant="primary" onClick={confirmTransition}>
              {t(transition?.kind === 'source'
                ? 'switchToSource.confirm'
                : reviewRequired
                  ? 'reviewRequired.confirm'
                  : 'switchToVisual.confirm')}
            </Button>
          </>
        )}
      >
        {transition?.kind === 'visual' ? (
          <div className="content-editor-mode-comparison">
            <Notice tone={reviewRequired ? 'warning' : 'info'}>
              {t(reviewRequired
                ? 'reviewRequired.summary'
                : transition.result.normalized
                  ? 'switchToVisual.normalized'
                  : 'switchToVisual.unchanged')}
            </Notice>
            {transition.result.classification === 'review_required' ? (
              <ul className="content-editor-compatibility-reasons">
                {transition.result.reasons.map((reason) => (
                  <li key={reason}>{t(`reviewRequired.reasons.${reason}`)}</li>
                ))}
              </ul>
            ) : null}
            {transition.result.normalized ? (
              <RevisionSourceComparison
                copy={{
                  diffLabel: t('switchToVisual.diffLabel'),
                  diffLoading: t('switchToVisual.diffLoading'),
                  diffUnavailable: t('switchToVisual.diffUnavailable'),
                  diffRetry: t('switchToVisual.diffRetry'),
                  leftSource: t('switchToVisual.sourceLabel'),
                  rightSource: t('switchToVisual.canonicalLabel'),
                }}
                original={input.value}
                modified={transition.result.canonicalHtml}
                originalDocumentType="html"
                modifiedDocumentType="html"
                originalEditorMode="source"
                modifiedEditorMode="visual"
                originalEditorProfile={null}
                modifiedEditorProfile="tiptap-v1"
              />
            ) : null}
          </div>
        ) : null}
        {transition?.kind === 'incompatible' ? (
          <ul className="content-editor-compatibility-reasons">
            {transition.result.reasons.map((reason) => (
              <li key={reason}>{t(`incompatible.reasons.${reason}`)}</li>
            ))}
          </ul>
        ) : null}
      </Dialog>
    </div>
  );
});
