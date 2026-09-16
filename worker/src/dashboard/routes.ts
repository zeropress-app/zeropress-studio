import { Hono } from 'hono';
import { hasStudioCapability } from '../../../contracts/authorization';
import {
  dashboardSummarySuccessSchema,
  type DashboardSummary,
} from '../../../contracts/dashboard';
import { requireStudioSession } from '../auth/authorization';
import type { ResolveUserSession } from '../auth/session-repository';
import {
  logStudioOperationalError,
  StudioOperationalError,
} from '../lib/operational-error';
import { readMailSettings } from '../mail/settings-repository';
import type { StudioHonoEnvironment } from '../types';
import {
  readDashboardEdgeOverview,
  readDashboardStudioOverview,
  type DashboardPermissions,
} from './repository';
import {
  postAccessAuthorId,
  resolvePostAccess,
} from '../posts/post-access';
import { readEdgeIntegrationModeFailClosed } from '../settings/edge-services-repository';
import { countPendingCommentTargetEvents } from '../comments/target-projection-outbox';
import {
  edgeHealthFailure,
  inspectEdgeIntegration,
} from '../settings/edge-integration-health';
import { readContentSearchIndexState } from '../content-search/index-repository';

export type DashboardRouteDependencies = {
  resolveSession?: ResolveUserSession;
  readStudio?: typeof readDashboardStudioOverview;
  readEdge?: typeof readDashboardEdgeOverview;
  readMail?: typeof readMailSettings;
  resolvePostAccess?: typeof resolvePostAccess;
  logEdgeFailure?: (error: StudioOperationalError) => void;
  now?: () => Date;
  readEdgeMode?: typeof readEdgeIntegrationModeFailClosed;
  countPendingEdgeTargets?: typeof countPendingCommentTargetEvents;
  inspectEdge?: typeof inspectEdgeIntegration;
  readContentSearchIndex?: typeof readContentSearchIndexState;
};

function permissions(roles: readonly string[]): DashboardPermissions {
  return {
    posts: hasStudioCapability(roles, 'posts.contribute'),
    pages: hasStudioCapability(roles, 'pages.manage'),
    media: hasStudioCapability(roles, 'media.manage'),
    comments: hasStudioCapability(roles, 'comments.manage'),
    forms: hasStudioCapability(roles, 'forms.manage'),
    newsletters: hasStudioCapability(roles, 'newsletters.manage'),
    mail: hasStudioCapability(roles, 'settings.manage'),
  };
}

function edgeFailure(error: unknown): StudioOperationalError {
  return error instanceof StudioOperationalError
    ? error
    : new StudioOperationalError('DASHBOARD_EDGE_DATABASE_QUERY_FAILED', {
      cause: error,
      metadata: {
        resource: 'EDGE_DB',
        action: 'read_dashboard_edge_overview',
      },
    });
}

export function createDashboardRoutes(
  dependencies: DashboardRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const readStudio = dependencies.readStudio ?? readDashboardStudioOverview;
  const readEdge = dependencies.readEdge ?? readDashboardEdgeOverview;
  const readMail = dependencies.readMail ?? readMailSettings;
  const readPostAccess = dependencies.resolvePostAccess ?? resolvePostAccess;
  const readEdgeMode = dependencies.readEdgeMode
    ?? readEdgeIntegrationModeFailClosed;
  const countPendingEdgeTargets = dependencies.countPendingEdgeTargets
    ?? countPendingCommentTargetEvents;
  const inspectEdge = dependencies.inspectEdge ?? inspectEdgeIntegration;
  const readContentSearchIndex = dependencies.readContentSearchIndex
    ?? readContentSearchIndexState;

  routes.get('/summary', async (c) => {
    const session = await requireStudioSession({
      context: c,
      resolveSession: dependencies.resolveSession,
    });
    if (session instanceof Response) return session;

    const allowed = permissions(session.user.roles);
    const postAccess = allowed.posts
      ? await readPostAccess({
          db: c.env.DB,
          userId: session.user.id,
          roles: session.user.roles,
        })
      : null;
    const mailNeeded = allowed.mail || allowed.forms || allowed.newsletters;
    const [content, mailDocument] = await Promise.all([
      readStudio({
        db: c.env.DB,
        permissions: {
          posts: allowed.posts,
          pages: allowed.pages,
          media: allowed.media,
        },
        ...(postAccess ? { postAccess } : {}),
        ...(postAccess && postAccess.scope !== 'all'
          ? { postAuthorId: postAccessAuthorId(postAccess) }
          : {}),
      }),
      mailNeeded ? readMail({ db: c.env.DB }) : Promise.resolve(null),
    ]);
    const mailConfigured = mailDocument?.configured ?? false;
    let contentSearchIndex: DashboardSummary['content_search_index'] = null;
    if (hasStudioCapability(session.user.roles, 'settings.manage')) {
      try {
        const state = await readContentSearchIndex(c.env.DB);
        contentSearchIndex = { state: state.state };
      } catch (error) {
        const failure = error instanceof StudioOperationalError
          ? error
          : new StudioOperationalError(
              'CONTENT_SEARCH_INDEX_STATE_QUERY_FAILED',
              {
                cause: error,
                metadata: {
                  resource: 'DB',
                  action: 'read_dashboard_content_search_index_state',
                },
              },
            );
        logStudioOperationalError(failure, {
          method: c.req.method,
          pathname: new URL(c.req.url).pathname,
        });
        contentSearchIndex = { state: 'unavailable' };
      }
    }
    const edgeRequested = allowed.comments
      || allowed.forms
      || allowed.newsletters;
    let edge: DashboardSummary['edge'];

    if (!edgeRequested) {
      edge = { status: 'not_requested' };
    } else {
      const [mode, pendingTargetEvents] = await Promise.all([
        readEdgeMode({ db: c.env.DB }),
        countPendingEdgeTargets({ db: c.env.DB }),
      ]);
      if (mode === 'disabled') {
        edge = {
          status: 'disabled',
          pending_target_events: pendingTargetEvents,
        };
      } else if (pendingTargetEvents > 0) {
        edge = {
          status: 'projection_pending',
          pending_target_events: pendingTargetEvents,
        };
      } else {
        const health = await inspectEdge({ env: c.env });
        if (health.state === 'unavailable') {
          const failure = edgeHealthFailure(health);
          if (dependencies.logEdgeFailure) {
            dependencies.logEdgeFailure(failure);
          } else {
            logStudioOperationalError(failure, {
              method: c.req.method,
              pathname: new URL(c.req.url).pathname,
            });
          }
          edge = { status: 'unavailable', pending_target_events: 0 };
        } else if (health.state === 'projection_pending') {
          edge = {
            status: 'projection_pending',
            pending_target_events: health.pendingTargetEvents,
          };
        } else {
          try {
            const overview = await readEdge({
              edgeDb: c.env.EDGE_DB,
              permissions: {
                comments: allowed.comments,
                forms: allowed.forms,
                newsletters: allowed.newsletters,
              },
              mailConfigured,
            });
            edge = health.state === 'reconciliation_required'
              ? {
                  ...overview,
                  status: 'reconciliation_required',
                  pending_target_events: 0,
                }
              : overview;
          } catch (error) {
            const failure = edgeFailure(error);
            if (dependencies.logEdgeFailure) {
              dependencies.logEdgeFailure(failure);
            } else {
              logStudioOperationalError(failure, {
                method: c.req.method,
                pathname: new URL(c.req.url).pathname,
              });
            }
            edge = { status: 'unavailable', pending_target_events: 0 };
          }
        }
      }
    }

    return c.json(dashboardSummarySuccessSchema.parse({
      success: true,
      data: {
        generated_at_iso: (dependencies.now?.() ?? new Date()).toISOString(),
        content,
        mail: allowed.mail ? { configured: mailConfigured } : null,
        edge,
        content_search_index: contentSearchIndex,
      },
    }));
  });

  return routes;
}
