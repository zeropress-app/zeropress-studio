import {
  useEffect,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';
import { Link } from 'react-router';
import { hasStudioCapability } from '../../contracts/authorization';
import type { DashboardSummary } from '../../contracts/dashboard';
import type { CurrentSessionSuccess } from '../../contracts/session';
import {
  Button,
  ButtonLink,
  Callout,
  EmptyState,
  InlineStatus,
  Notice,
  PageHeader,
  Panel,
  StatusPill,
  type StatusTone,
} from './components/primitives';
import {
  DashboardClientError,
  requestDashboardSummary,
} from './lib/dashboard-client';
import { requestCloudflareAccessSettings } from './lib/cloudflare-access-client';
import { STUDIO_PATHS } from './routing/studio-routes';

type DashboardSession = CurrentSessionSuccess['data'];
type Failure = 'network' | 'timeout' | 'invalid' | 'api';
type RuntimeState = 'ready' | 'disabled' | 'needsSetup';

/** Map service readiness to the primitives' semantic tones. */
const RUNTIME_TONE: Record<RuntimeState, StatusTone> = {
  ready: 'positive',
  disabled: 'neutral',
  needsSetup: 'attention',
};

function runtimeState(enabled: boolean, ready: boolean): RuntimeState {
  if (!enabled) return 'disabled';
  return ready ? 'ready' : 'needsSetup';
}

function RuntimeRow(input: { label: string; state: RuntimeState }) {
  const { t } = useTranslation('dashboard');
  return (
    <div className="dashboard-runtime-row">
      <span className="dashboard-runtime-label">{input.label}</span>
      <StatusPill tone={RUNTIME_TONE[input.state]}>
        {t(`runtime.states.${input.state}`)}
      </StatusPill>
    </div>
  );
}

export function DashboardPage(input: {
  data: DashboardSession;
  onSessionEnded: () => void;
}) {
  const { t } = useTranslation('dashboard');
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const roles = input.data.user.roles;
  const canManageSettings = hasStudioCapability(roles, 'settings.manage');
  const [accessRecommendation, setAccessRecommendation] = useState(false);

  useStudioDocumentTitle(t('documentTitle'));

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailure(null);
    requestDashboardSummary(controller.signal).then((response) => {
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setFailure('api');
        return;
      }
      setSummary(response.data);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof DashboardClientError) {
        setFailure(error.code === 'TIMEOUT'
          ? 'timeout'
          : error.code === 'NETWORK_ERROR' ? 'network' : 'invalid');
      } else setFailure('network');
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [attempt, input.onSessionEnded]);

  useEffect(() => {
    if (!canManageSettings) return;
    const controller = new AbortController();
    void requestCloudflareAccessSettings(controller.signal)
      .then((response) => {
        if (!response.success) return;
        setAccessRecommendation(
          response.data.settings.mode === 'disabled'
          && response.data.detection_state === 'verified',
        );
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [attempt, canManageSettings]);

  function retry() {
    setAttempt((value) => value + 1);
  }

  const edge = summary?.edge.status === 'available'
    || summary?.edge.status === 'reconciliation_required'
    ? summary.edge
    : null;
  const postAccess = summary?.content.posts?.access ?? null;
  const attention = edge ? [
    edge.comments ? {
      id: 'comments', count: edge.comments.pending,
      label: t('attention.pendingComments'), path: STUDIO_PATHS.comments,
    } : null,
    edge.forms ? {
      id: 'forms', count: edge.forms.unread_submissions,
      label: t('attention.unreadForms'), path: STUDIO_PATHS.forms,
    } : null,
    edge.newsletters ? {
      id: 'newsletters', count: edge.newsletters.pending_confirmations,
      label: t('attention.pendingSubscriptions'),
      path: STUDIO_PATHS.newsletters,
    } : null,
  ].filter((value): value is NonNullable<typeof value> => value !== null) : [];
  const flagged = attention.filter((item) => item.count > 0);
  const canOfferWordPressImport = summary !== null
    && hasStudioCapability(roles, 'imports.manage')
    && summary.content.posts?.total === 0
    && summary.content.pages?.total === 0;
  const quickActions = [
    hasStudioCapability(roles, 'posts.contribute')
      && postAccess?.scope !== 'unavailable'
      ? { path: STUDIO_PATHS.newPost, label: t('quickActions.newPost') }
      : null,
    hasStudioCapability(roles, 'pages.manage')
      ? { path: STUDIO_PATHS.newPage, label: t('quickActions.newPage') }
      : null,
    canOfferWordPressImport
      ? {
          path: STUDIO_PATHS.wxrImport,
          label: t('quickActions.wordpressImport'),
        }
      : null,
    edge && hasStudioCapability(roles, 'comments.manage')
      ? { path: STUDIO_PATHS.comments, label: t('quickActions.comments') }
      : null,
    edge && hasStudioCapability(roles, 'forms.manage')
      ? { path: STUDIO_PATHS.forms, label: t('quickActions.forms') }
      : null,
    edge && hasStudioCapability(roles, 'newsletters.manage')
      ? { path: STUDIO_PATHS.newsletters, label: t('quickActions.newsletters') }
      : null,
    hasStudioCapability(roles, 'publish.manage')
      ? { path: STUDIO_PATHS.publish, label: t('quickActions.previewData') }
      : null,
  ].filter((value): value is NonNullable<typeof value> => value !== null);

  const contentCards = summary ? [
    summary.content.posts ? {
      id: 'posts', path: STUDIO_PATHS.posts,
      label: summary.content.posts.access.scope === 'own'
        ? t('content.myPosts', {
            author: summary.content.posts.access.author.display_name,
          })
        : summary.content.posts.access.scope === 'unavailable'
          ? t('content.myPostsUnavailable')
          : t('content.posts'),
      value: summary.content.posts.total,
      detail: t('content.statusSummary', summary.content.posts),
    } : null,
    summary.content.pages ? {
      id: 'pages', path: STUDIO_PATHS.pages, label: t('content.pages'),
      value: summary.content.pages.total,
      detail: t('content.statusSummary', summary.content.pages),
    } : null,
    summary.content.media ? {
      id: 'media', path: STUDIO_PATHS.media, label: t('content.media'),
      value: summary.content.media.total,
      detail: t('content.mediaSummary', summary.content.media),
    } : null,
  ].filter((value): value is NonNullable<typeof value> => value !== null) : [];

  const runtimeRows = summary ? [
    summary.content_search_index ? {
      id: 'content-search-index',
      label: t('runtime.contentSearch'),
      state: summary.content_search_index.state === 'ready'
        ? 'ready' as const
        : 'needsSetup' as const,
    } : null,
    summary.edge.status === 'disabled' ? {
      id: 'edge-integration', label: t('runtime.edgeIntegration'),
      state: 'disabled' as const,
    } : null,
    edge?.comments ? {
      id: 'comments', label: t('runtime.comments'),
      state: runtimeState(edge.comments.enabled, edge.comments.api_configured),
    } : null,
    edge?.newsletters ? {
      id: 'newsletters', label: t('runtime.newsletterConfirmation'),
      state: runtimeState(
        edge.newsletters.confirmation_enabled,
        edge.newsletters.confirmation_ready,
      ),
    } : null,
    summary.mail ? {
      id: 'mail', label: t('runtime.mail'),
      state: summary.mail.configured
        ? 'ready' as const
        : 'needsSetup' as const,
    } : null,
  ].filter((value): value is NonNullable<typeof value> => value !== null) : [];

  return (
    <main
      id="studio-main-content"
      aria-labelledby="dashboard-title"
    >
      <PageHeader
        titleId="dashboard-title"
        kicker={t('kicker')}
        title={t('title')}
      />

      <div className="dashboard-stack">
        {loading && !summary ? (
          <InlineStatus size="lg">{t('loading')}</InlineStatus>
        ) : null}

        {failure ? (
          <Notice
            tone="error"
            title={t('errors.title')}
            actions={(
              <Button type="button" onClick={retry}>{t('retry')}</Button>
            )}
          >
            {t(`errors.${failure}`)}
          </Notice>
        ) : null}

        {summary?.edge.status === 'unavailable' ? (
          <Notice
            tone="warning"
            title={t('edgeUnavailable.title')}
            actions={(
              <Button type="button" onClick={retry}>{t('retry')}</Button>
            )}
          >
            {t('edgeUnavailable.description')}
          </Notice>
        ) : null}

        {summary?.edge.status === 'reconciliation_required' ? (
          <Notice
            tone="warning"
            title={t('edgeReconciliation.title')}
            actions={hasStudioCapability(roles, 'settings.manage') ? (
              <ButtonLink to={STUDIO_PATHS.edgeServicesSettings}>
                {t('edgeReconciliation.action')}
              </ButtonLink>
            ) : undefined}
          >
            {t('edgeReconciliation.description')}
          </Notice>
        ) : null}

        {summary?.edge.status === 'projection_pending' ? (
          <Notice tone="warning" title={t('edgePending.title')}>
            {t('edgePending.description', {
              count: summary.edge.pending_target_events,
            })}
          </Notice>
        ) : null}

        {postAccess?.scope === 'unavailable' ? (
          <Callout
            tone="warning"
            title={t('content.authorLinkRequiredTitle')}
          >
            {t('content.authorLinkRequiredDescription')}
          </Callout>
        ) : null}

        {accessRecommendation ? (
          <Callout tone="info" title={t('cloudflareAccess.title')}>
            <p>{t('cloudflareAccess.description')}</p>
            <ButtonLink to="/system/operations/access">
              {t('cloudflareAccess.action')}
            </ButtonLink>
          </Callout>
        ) : null}

        {contentCards.length > 0 ? (
          <Panel kicker={t('content.kicker')} title={t('content.title')}>
            <div className="dashboard-card-grid">
              {contentCards.map((card) => (
                <Link
                  key={card.id}
                  className="dashboard-overview-card"
                  to={card.path}
                >
                  <span className="dashboard-card-label">{card.label}</span>
                  <strong className="dashboard-card-value">{card.value}</strong>
                  <span className="dashboard-card-detail">{card.detail}</span>
                </Link>
              ))}
            </div>
          </Panel>
        ) : null}

        {edge || (summary && quickActions.length > 0) ? (
          <div className="dashboard-secondary-grid">
            {edge ? (
              <Panel
                kicker={t('attention.kicker')}
                title={t('attention.title')}
              >
                {flagged.length === 0 ? (
                  <EmptyState title={t('attention.none')} />
                ) : (
                  <ul className="dashboard-attention-list">
                    {flagged.map((item) => (
                      <li key={item.id}>
                        <Link to={item.path}>
                          <strong className="dashboard-attention-count">
                            {item.count}
                          </strong>
                          <span className="dashboard-attention-label">
                            {item.label}
                          </span>
                          <span
                            className="dashboard-link-arrow"
                            aria-hidden="true"
                          >
                            →
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            ) : null}

            {summary && quickActions.length > 0 ? (
              <Panel
                kicker={t('quickActions.kicker')}
                title={t('quickActions.title')}
              >
                <ul className="dashboard-quick-actions">
                  {quickActions.map((action) => (
                    <li key={action.path}>
                      <Link to={action.path}>
                        <span className="dashboard-quick-action-label">
                          {action.label}
                        </span>
                        <span
                          className="dashboard-link-arrow"
                          aria-hidden="true"
                        >
                          →
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}
          </div>
        ) : null}

        {runtimeRows.length > 0 ? (
          <Panel kicker={t('runtime.kicker')} title={t('runtime.title')}>
            <div className="dashboard-runtime-grid">
              {runtimeRows.map((row) => (
                <RuntimeRow key={row.id} label={row.label} state={row.state} />
              ))}
            </div>
          </Panel>
        ) : null}

        {summary && contentCards.length === 0 && !edge
          && runtimeRows.length === 0 && quickActions.length === 0 ? (
            <EmptyState title={t('noOverview')} />
          ) : null}

      </div>
    </main>
  );
}
