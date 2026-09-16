import {
  type FormEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, RotateCcw, Save } from 'lucide-react';
import { useStudioDocumentTitle } from '../StudioSiteIdentityContext';
import {
  Button,
  Notice,
  PageHeader,
  Spinner,
  StudioIcon,
} from './primitives';
import { EdgeSettingsLayout } from './EdgeSettingsLayout';
import { SiteSettingsNavigation } from './SiteSettingsNavigation';
import { UnsavedChangesGuard } from './UnsavedChangesGuard';

/** Settings document states: loading, failed, or editable. */
export type SettingsLoadState = 'loading' | 'error' | 'ready';

/**
 * Save progress.
 *
 * Validation fails before submission; conflict means another session saved first. Both preserve
 * the user's edits in the form.
 */
export type SettingsSaveState =
  | 'idle'
  | 'saving'
  | 'saved'
  | 'validation'
  | 'conflict';

/** A title and optional supporting description. */
type Block = { title: string; description?: string };

/**
 * Shared frame for site-settings screens.
 *
 * Owns headings, section navigation, loading states, save notices, the action bar, and
 * unsaved-change warnings. Screens supply section cards as children.
 *
 * Screen-specific translated text, such as titles and save confirmations, comes through copy.
 * Common text for changes, reset, saving, retry, and navigation warnings comes directly from the
 * settings namespace so screens stay consistent.
 */
export function SettingsScreen(input: {
  /** The independent settings navigation structure containing this screen. */
  navigation: 'site' | 'edge';
  /** Screen-specific text, already translated. */
  copy: {
    documentTitle: string;
    kicker: string;
    title: string;
    description: string;
    /** Loading message. */
    loading: Block;
    /** Load-failure message. */
    loadError: Block;
    /** Save-success notice. */
    saved: string;
    /** Notice for validation that fails before submission. */
    validation: string;
    /** Revision-conflict notice. */
    conflict: Block;
    /** Save-button label, including the screen's target name. */
    save: string;
  };
  load: SettingsLoadState;
  onRetry: () => void;
  /** Specific reason for the load failure, already translated. */
  loadErrorDetail?: string | null;
  /** Screen-specific action for explicitly recovering a damaged settings document. */
  loadErrorAction?: { label: string; onClick: () => void };
  save: SettingsSaveState;
  /** Translated error text. Omit to hide the error notice. */
  error?: string | null;
  /**
   * Action to reload current values and resolve a conflict. Supplying it with a label adds a
   * button to the conflict notice so the user can act on the problem.
   */
  reload?: { label: string; onReload: () => void };
  /** Whether there are unsaved changes. Controls both the action bar and navigation warning. */
  dirty: boolean;
  /**
   * Whether screen-level validation has passed. Invalid values block saving even when changes
   * exist. Defaults to true.
   */
  canSave?: boolean;
  /** One line below the change indicator, used for the last-save time or default-value guidance. */
  statusDetail?: string | null;
  onReset: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /** Section cards, rendered only when load is ready. */
  children: ReactNode;
}) {
  const { t } = useTranslation('settings');
  const { copy } = input;
  const saving = input.save === 'saving';
  const conflicted = input.save === 'conflict';
  const canSave = input.canSave ?? true;
  const site = input.navigation === 'site';

  useStudioDocumentTitle(copy.documentTitle);

  const content = (
    <>
      {input.load === 'loading' ? (
        <div className="settings-state" role="status">
          <Spinner size="lg" />
          <div className="settings-state-copy">
            <p className="settings-state-title">{copy.loading.title}</p>
            {copy.loading.description ? (
              <p className="settings-state-description">
                {copy.loading.description}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {input.load === 'error' ? (
        <Notice
          tone="error"
          title={copy.loadError.title}
          actions={(
            <>
              <Button type="button" onClick={input.onRetry}>
                <StudioIcon icon={RefreshCw} />
                {t('shared.actions.retry')}
              </Button>
              {input.loadErrorAction ? (
                <Button
                  type="button"
                  variant="primary"
                  onClick={input.loadErrorAction.onClick}
                >
                  {input.loadErrorAction.label}
                </Button>
              ) : null}
            </>
          )}
        >
          {/* Read the specific cause first, followed by the guidance. */}
          {[input.loadErrorDetail, copy.loadError.description]
            .filter((value): value is string => Boolean(value))
            .join(' ')}
        </Notice>
      ) : null}

      {input.load === 'ready' ? (
        <form className="settings-form" onSubmit={input.onSubmit}>
          {input.save === 'saved' ? (
            <Notice tone="success">{copy.saved}</Notice>
          ) : null}
          {input.save === 'validation' ? (
            <Notice tone="error">{copy.validation}</Notice>
          ) : null}
          {conflicted ? (
            <Notice
              tone="error"
              title={copy.conflict.title}
              actions={input.reload ? (
                <Button type="button" onClick={input.reload.onReload}>
                  <StudioIcon icon={RefreshCw} />
                  {input.reload.label}
                </Button>
              ) : undefined}
            >
              {copy.conflict.description ?? ''}
            </Notice>
          ) : null}
          {input.error ? <Notice tone="error">{input.error}</Notice> : null}

          {input.children}

          <footer className={site
            ? 'settings-actions site-settings-actions'
            : 'settings-actions'}>
            {/*
             * Disabled save/reset buttons alone communicate changes through color and gray tones.
             * Also describe the state in text and announce it as an action result in a live
             * region.
             */}
            <div className="settings-actions-state" aria-live="polite">
              <p className="settings-actions-status">
                {input.dirty ? t('shared.state.dirty') : t('shared.state.clean')}
              </p>
              {input.statusDetail ? (
                <p className="settings-actions-detail">{input.statusDetail}</p>
              ) : null}
            </div>
            <div className={site
              ? 'settings-actions-buttons site-settings-action-buttons'
              : 'settings-actions-buttons'}>
              <Button
                type="button"
                disabled={!input.dirty || saving || conflicted}
                onClick={input.onReset}
              >
                <StudioIcon icon={RotateCcw} />
                {t(site ? 'siteActions.reset' : 'shared.actions.reset')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={!input.dirty || !canSave || saving || conflicted}
              >
                {saving ? <Spinner /> : <StudioIcon icon={Save} />}
                {saving ? t('shared.actions.saving') : copy.save}
              </Button>
            </div>
          </footer>
        </form>
      ) : null}
    </>
  );

  return (
    <main id="studio-main-content">
      <PageHeader
        titleId="settings-title"
        kicker={copy.kicker}
        title={copy.title}
        description={copy.description}
      />
      {site ? (
        <div className="site-settings-layout">
          <SiteSettingsNavigation />
          <div className="site-settings-content">{content}</div>
        </div>
      ) : (
        <EdgeSettingsLayout>{content}</EdgeSettingsLayout>
      )}
      <UnsavedChangesGuard
        active={input.dirty && !saving}
        copy={{
          kicker: t('shared.discard.kicker'),
          title: t('shared.discard.title'),
          description: t('shared.discard.description'),
          stay: t('shared.discard.stay'),
          leave: t('shared.discard.leave'),
        }}
      />
    </main>
  );
}
