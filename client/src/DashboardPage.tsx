import {
  useEffect,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';
import { Link } from 'react-router';
import {
  Activity,
  ArrowRight,
  ClipboardCheck,
  ClipboardList,
  CloudCog,
  FileJson,
  FilePlus2,
  Files,
  Images,
  Import,
  Mail,
  MailCheck,
  MessagesSquare,
  Newspaper,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  SquarePen,
  Zap,
} from 'lucide-react';
import { hasStudioCapability } from '../../contracts/authorization';
import type { DashboardSummary } from '../../contracts/dashboard';
import { DashboardSearchIndexCard } from './components/DashboardSearchIndexCard';
import { DashboardRuntimeRow, type RuntimeState } from './components/DashboardRuntimeRow';
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
  StudioIcon,
} from './components/primitives';
import {
  DashboardClientError,
  requestDashboardSummary,
} from './lib/dashboard-client';
import { requestCloudflareAccessSettings } from './lib/cloudflare-access-client';
import { STUDIO_PATHS } from './routing/studio-routes';

type DashboardSession = CurrentSessionSuccess['data'];
type Failure = 'network' | 'timeout' | 'invalid' | 'api';

function runtimeState(enabled: boolean, ready: boolean): RuntimeState {
  if (!enabled) return 'disabled';
  return ready ? 'ready' : 'needsSetup';
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
      icon: MessagesSquare,
      label: t('attention.pendingComments'), path: STUDIO_PATHS.comments,
    } : null,
    edge.forms ? {
      id: 'forms', count: edge.forms.unread_submissions,
      icon: ClipboardList,
      label: t('attention.unreadForms'), path: STUDIO_PATHS.forms,
    } : null,
    edge.newsletters ? {
      id: 'newsletters', count: edge.newsletters.pending_confirmations,
      icon: Mail,
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
      ? { path: STUDIO_PATHS.newPost, label: t('quickActions.newPost'), icon: SquarePen }
      : null,
    hasStudioCapability(roles, 'pages.manage')
      ? { path: STUDIO_PATHS.newPage, label: t('quickActions.newPage'), icon: FilePlus2 }
      : null,
    canOfferWordPressImport
      ? {
          path: STUDIO_PATHS.wxrImport,
          label: t('quickActions.wordpressImport'),
          icon: Import,
        }
      : null,
    edge && hasStudioCapability(roles, 'comments.manage')
      ? { path: STUDIO_PATHS.comments, label: t('quickActions.comments'), icon: MessagesSquare }
      : null,
    edge && hasStudioCapability(roles, 'forms.manage')
      ? { path: STUDIO_PATHS.forms, label: t('quickActions.forms'), icon: ClipboardList }
      : null,
    edge && hasStudioCapability(roles, 'newsletters.manage')
      ? { path: STUDIO_PATHS.newsletters, label: t('quickActions.newsletters'), icon: Mail }
      : null,
    hasStudioCapability(roles, 'publish.manage')
      ? { path: STUDIO_PATHS.publish, label: t('quickActions.previewData'), icon: FileJson }
      : null,
  ].filter((value): value is NonNullable<typeof value> => value !== null);

  const contentCards = summary ? [
    summary.content.posts ? {
      id: 'posts', path: STUDIO_PATHS.posts,
      icon: Newspaper,
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
      icon: Files,
      value: summary.content.pages.total,
      detail: t('content.statusSummary', summary.content.pages),
    } : null,
    summary.content.media ? {
      id: 'media', path: STUDIO_PATHS.media, label: t('content.media'),
      icon: Images,
      value: summary.content.media.total,
      detail: t('content.mediaSummary', summary.content.media),
    } : null,
  ].filter((value): value is NonNullable<typeof value> => value !== null) : [];

  const runtimeRows = summary ? [
    summary.edge.status === 'disabled' ? {
      id: 'edge-integration', label: t('runtime.edgeIntegration'),
      icon: CloudCog,
      state: 'disabled' as const,
      action: { label: t('runtime.actions.edge'), path: STUDIO_PATHS.edgeServicesSettings },
    } : null,
    edge?.comments ? {
      id: 'comments', label: t('runtime.comments'),
      icon: MessagesSquare,
      state: runtimeState(edge.comments.enabled, edge.comments.api_configured),
      action: {
        label: t('runtime.actions.comments'),
        path: edge.comments.enabled && !edge.comments.api_configured
          ? `${STUDIO_PATHS.commentSettings}#comment-api`
          : STUDIO_PATHS.commentSettings,
      },
    } : null,
    edge?.newsletters ? {
      id: 'newsletters', label: t('runtime.newsletterConfirmation'),
      icon: MailCheck,
      state: runtimeState(
        edge.newsletters.confirmation_enabled,
        edge.newsletters.confirmation_ready,
      ),
      action: {
        label: t('runtime.actions.newsletter'),
        path: `${STUDIO_PATHS.newsletters}?tab=runtime`,
      },
    } : null,
    summary.mail ? {
      id: 'mail', label: t('runtime.mail'),
      icon: Send,
      state: summary.mail.configured
        ? 'ready' as const
        : 'unconfigured' as const,
      action: { label: t('runtime.actions.mail'), path: STUDIO_PATHS.mailSettings },
    } : null,
  ].filter((value): value is NonNullable<typeof value> => value !== null) : [];
  const searchIndex = canManageSettings ? summary?.content_search_index : null;

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
              <Button type="button" onClick={retry}>
                <StudioIcon icon={RefreshCw} className="dashboard-action-icon" />
                {t('retry')}
              </Button>
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
              <Button type="button" onClick={retry}>
                <StudioIcon icon={RefreshCw} className="dashboard-action-icon" />
                {t('retry')}
              </Button>
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
                <StudioIcon icon={CloudCog} className="dashboard-action-icon" />
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
              <StudioIcon icon={ShieldCheck} className="dashboard-action-icon" />
              {t('cloudflareAccess.action')}
            </ButtonLink>
          </Callout>
        ) : null}

        {contentCards.length > 0 ? (
          <Panel kicker={t('content.kicker')} title={t('content.title')}
            leading={<StudioIcon icon={Files} />}>
            <div className="dashboard-card-grid">
              {contentCards.map((card) => (
                <Link
                  key={card.id}
                  className="dashboard-overview-card"
                  to={card.path}
                >
                  <div className="dashboard-card-heading">
                    <StudioIcon icon={card.icon} className="dashboard-card-icon" />
                    <span className="dashboard-card-label">{card.label}</span>
                  </div>
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
                leading={<StudioIcon icon={ClipboardCheck} />}
              >
                {flagged.length === 0 ? (
                  <EmptyState title={t('attention.none')} />
                ) : (
                  <ul className="dashboard-attention-list">
                    {flagged.map((item) => (
                      <li key={item.id}>
                        <Link to={item.path}>
                          <StudioIcon icon={item.icon} className="dashboard-item-icon" />
                          <strong className="dashboard-attention-count">
                            {item.count}
                          </strong>
                          <span className="dashboard-attention-label">
                            {item.label}
                          </span>
                          <StudioIcon icon={ArrowRight} className="dashboard-link-arrow" />
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
                leading={<StudioIcon icon={Zap} />}
              >
                <ul className="dashboard-quick-actions">
                  {quickActions.map((action) => (
                    <li key={action.path}>
                      <Link to={action.path}>
                        <StudioIcon icon={action.icon} className="dashboard-item-icon" />
                        <span className="dashboard-quick-action-label">
                          {action.label}
                        </span>
                        <StudioIcon icon={ArrowRight} className="dashboard-link-arrow" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}
          </div>
        ) : null}

        {runtimeRows.length > 0 || searchIndex ? (
          <Panel kicker={t('runtime.kicker')} title={t('runtime.title')}
            leading={<StudioIcon icon={Activity} />}>
            <div className="dashboard-runtime-grid">
              {searchIndex ? (
                <DashboardSearchIndexCard
                  key={attempt}
                  initialState={searchIndex.state}
                  csrfToken={input.data.csrf_token}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : null}
              {runtimeRows.map((row) => (
                <DashboardRuntimeRow key={row.id} label={row.label} state={row.state}
                  icon={row.icon}
                  actions={canManageSettings ? (
                    <ButtonLink size="sm" to={row.action.path}>
                      <StudioIcon icon={Settings2} className="dashboard-action-icon" />
                      {row.action.label}
                    </ButtonLink>
                  ) : undefined}
                />
              ))}
            </div>
          </Panel>
        ) : null}

        {summary && contentCards.length === 0 && !edge
          && runtimeRows.length === 0 && !searchIndex && quickActions.length === 0 ? (
            <EmptyState title={t('noOverview')} />
          ) : null}

      </div>
    </main>
  );
}
