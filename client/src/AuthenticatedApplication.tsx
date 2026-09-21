import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Route, Routes } from 'react-router';
import type { CurrentSessionSuccess } from '../../contracts/session';
import { hasStudioCapability } from '../../contracts/authorization';
import { DashboardPage } from './DashboardPage';
import { StudioNotFoundPage } from './StudioNotFoundPage';
import { StudioShell } from './components/StudioShell';
import { STUDIO_PATHS } from './routing/studio-routes';
import { RouteLoading, StudioToaster } from './components/primitives';
import { EdgeIntegrationProvider } from './EdgeIntegrationContext';
import { ensureNamespaces } from './i18n';
import type { StudioNamespace } from './i18n/namespaces';
import {
  StudioSiteIdentityProvider,
  type StudioSiteIdentity,
} from './StudioSiteIdentityContext';

type AuthenticatedSession = CurrentSessionSuccess['data'];

/**
 * Wait for both the screen chunk and its message catalogs.
 *
 * Load them in parallel so lazy catalogs do not add a sequential delay to navigation. Render the
 * screen only after its messages are ready. Boot namespaces are already bundled; declare only the
 * additional namespaces needed here. i18n/namespaces.test.ts checks these declarations.
 */
function lazyScreen<Props>(
  load: () => Promise<{ default: ComponentType<Props> }>,
  namespaces: readonly StudioNamespace[],
) {
  return lazy(async () => {
    const [module] = await Promise.all([
      load(),
      ensureNamespaces(namespaces),
    ]);
    return module;
  });
}

const StudioPreferencesPage = lazyScreen(
  async () => ({
    default: (await import('./StudioPreferencesPage')).StudioPreferencesPage,
  }),
  ['preferences'],
);

const AccountSecurityPage = lazyScreen(
  async () => ({
    default: (await import('./AccountSecurityPage')).AccountSecurityPage,
  }),
  ['security'],
);

const MfaManagementPage = lazyScreen(
  async () => ({
    default: (await import('./MfaManagementPage')).MfaManagementPage,
  }),
  ['security'],
);

const PasswordChangePage = lazyScreen(
  async () => ({
    default: (await import('./PasswordChangePage')).PasswordChangePage,
  }),
  ['security'],
);

const WebAuthnManagementPage = lazyScreen(
  async () => ({
    default: (await import('./WebAuthnManagementPage')).WebAuthnManagementPage,
  }),
  ['security'],
);

const StudioAccessDeniedPage = lazyScreen(
  async () => ({
    default: (await import('./StudioAccessDeniedPage')).StudioAccessDeniedPage,
  }),
  [],
);

const UserManagementPage = lazyScreen(
  async () => ({
    default: (await import('./UserManagementPage')).UserManagementPage,
  }),
  [],
);

const AuthorsPage = lazyScreen(
  async () => ({ default: (await import('./AuthorsPage')).AuthorsPage }),
  ['authors', 'media'],
);

const PostsPage = lazyScreen(
  async () => ({ default: (await import('./PostsPage')).PostsPage }),
  ['posts'],
);

const PostEditorPage = lazyScreen(
  async () => ({
    default: (await import('./PostEditorPage')).PostEditorPage,
  }),
  ['contentEditor', 'media', 'posts'],
);

const PagesPage = lazyScreen(
  async () => ({ default: (await import('./PagesPage')).PagesPage }),
  ['pages'],
);

const PageEditorPage = lazyScreen(
  async () => ({
    default: (await import('./PageEditorPage')).PageEditorPage,
  }),
  ['contentEditor', 'media', 'pages'],
);

const TaxonomyPage = lazyScreen(
  async () => ({ default: (await import('./TaxonomyPage')).TaxonomyPage }),
  ['taxonomies'],
);

const MenusPage = lazyScreen(
  async () => ({ default: (await import('./MenusPage')).MenusPage }),
  ['menus'],
);

const WidgetsPage = lazyScreen(
  async () => ({ default: (await import('./WidgetsPage')).WidgetsPage }),
  ['widgets'],
);

const GeneralSettingsPage = lazyScreen(
  async () => ({
    default: (await import('./GeneralSettingsPage')).GeneralSettingsPage,
  }),
  ['settings'],
);

const StudioInterfaceSettingsPage = lazyScreen(
  async () => ({
    default: (await import('./StudioInterfaceSettingsPage'))
      .StudioInterfaceSettingsPage,
  }),
  ['interfaceSettings', 'settings'],
);

const SiteBrandingPage = lazyScreen(
  async () => ({
    default: (await import('./SiteBrandingPage')).SiteBrandingPage,
  }),
  ['brandingSettings', 'media', 'settings'],
);

const CustomCodeSettingsPage = lazyScreen(
  async () => ({
    default: (await import('./CustomCodeSettingsPage')).CustomCodeSettingsPage,
  }),
  ['customCodeSettings', 'settings'],
);

const OutputSettingsPage = lazyScreen(
  async () => ({
    default: (await import('./OutputSettingsPage')).OutputSettingsPage,
  }),
  ['outputSettings', 'settings'],
);

const RoutingSettingsPage = lazyScreen(
  async () => ({
    default: (await import('./RoutingSettingsPage')).RoutingSettingsPage,
  }),
  ['routingSettings', 'settings'],
);

const CommentSettingsPage = lazyScreen(
  async () => ({
    default: (await import('./CommentSettingsPage')).CommentSettingsPage,
  }),
  ['settings'],
);

const EdgeSecuritySettingsPage = lazyScreen(
  async () => ({
    default: (await import('./EdgeSecuritySettingsPage'))
      .EdgeSecuritySettingsPage,
  }),
  ['edgeSecuritySettings', 'settings'],
);

const EdgeServicesSettingsPage = lazyScreen(
  async () => ({
    default: (await import('./EdgeServicesSettingsPage'))
      .EdgeServicesSettingsPage,
  }),
  ['settings'],
);

const EdgeIntegrationDisabledPage = lazyScreen(
  async () => ({
    default: (await import('./EdgeIntegrationDisabledPage'))
      .EdgeIntegrationDisabledPage,
  }),
  ['settings'],
);

const EdgeIntegrationUnavailablePage = lazyScreen(
  async () => ({
    default: (await import('./EdgeIntegrationUnavailablePage'))
      .EdgeIntegrationUnavailablePage,
  }),
  ['settings'],
);

const CommentsPage = lazyScreen(
  async () => ({ default: (await import('./CommentsPage')).CommentsPage }),
  ['comments'],
);

const NewslettersPage = lazyScreen(
  async () => ({
    default: (await import('./NewslettersPage')).NewslettersPage,
  }),
  ['newsletters'],
);

const FormsPage = lazyScreen(
  async () => ({ default: (await import('./FormsPage')).FormsPage }),
  ['forms'],
);

const MediaPage = lazyScreen(
  async () => ({ default: (await import('./MediaPage')).MediaPage }),
  ['media'],
);

const MediaSettingsPage = lazyScreen(
  async () => ({
    default: (await import('./MediaSettingsPage')).MediaSettingsPage,
  }),
  ['mediaSettings', 'settings'],
);

const NewsletterSettingsPage = lazyScreen(
  async () => ({
    default: (await import('./NewsletterSettingsPage')).NewsletterSettingsPage,
  }),
  ['newsletterSettings', 'settings'],
);

const AnalyticsPage = lazyScreen(
  async () => ({ default: (await import('./AnalyticsPage')).AnalyticsPage }),
  ['analytics'],
);
const PublishingSettingsPage = lazyScreen(
  async () => ({ default: (await import('./PublishingSettingsPage')).PublishingSettingsPage }),
  ['publishing', 'settings'],
);
const AnalyticsSettingsPage = lazyScreen(
  async () => ({ default: (await import('./AnalyticsSettingsPage')).AnalyticsSettingsPage }),
  ['analytics', 'settings'],
);

const MailSettingsPage = lazyScreen(
  async () => ({
    default: (await import('./MailSettingsPage')).MailSettingsPage,
  }),
  ['mailSettings', 'settings'],
);

const PreviewDataPage = lazyScreen(
  async () => ({
    default: (await import('./PreviewDataPage')).PreviewDataPage,
  }),
  ['previewData', 'publishing'],
);

const WxrImportPage = lazyScreen(
  async () => ({ default: (await import('./WxrImportPage')).WxrImportPage }),
  ['wxrImport'],
);

function StudioRouteLoading() {
  const { t } = useTranslation('studio');
  return <RouteLoading>{t('routeLoading')}</RouteLoading>;
}

function DeferredRoute(input: { children: ReactNode }) {
  return (
    <Suspense fallback={<StudioRouteLoading />}>
      {input.children}
    </Suspense>
  );
}

export function AuthenticatedApplication(input: {
  data: AuthenticatedSession;
  onSessionEnded: () => void;
  onSignedOut?: () => void;
  onCurrentUserNameChanged?: (name: string) => void;
}) {
  const [siteIdentity, setSiteIdentity] = useState<StudioSiteIdentity>({
    title: input.data.site_title ?? '',
    url: input.data.site_url ?? '',
  });
  const [edgeIntegrationMode, setEdgeIntegrationMode] = useState(
    input.data.edge_integration.mode,
  );
  const [edgeDatabaseState, setEdgeDatabaseState] = useState(
    input.data.edge_integration.database_state ?? 'ready',
  );
  const onSignedOut = input.onSignedOut ?? input.onSessionEnded;

  useEffect(() => {
    setSiteIdentity({
      title: input.data.site_title ?? '',
      url: input.data.site_url ?? '',
    });
  }, [input.data.site_title, input.data.site_url]);

  useEffect(() => {
    setEdgeIntegrationMode(input.data.edge_integration.mode);
    setEdgeDatabaseState(input.data.edge_integration.database_state ?? 'ready');
  }, [
    input.data.edge_integration.database_state,
    input.data.edge_integration.mode,
  ]);

  const canManageUsers = hasStudioCapability(
    input.data.user.roles,
    'users.manage',
  );
  const canManageAuthors = hasStudioCapability(
    input.data.user.roles,
    'authors.manage',
  );
  const canAccessPosts = hasStudioCapability(
    input.data.user.roles,
    'posts.contribute',
  );
  const canManagePages = hasStudioCapability(
    input.data.user.roles,
    'pages.manage',
  );
  const canManageTaxonomies = hasStudioCapability(
    input.data.user.roles,
    'taxonomies.manage',
  );
  const canManageMenus = hasStudioCapability(
    input.data.user.roles,
    'menus.manage',
  );
  const canManageWidgets = hasStudioCapability(
    input.data.user.roles,
    'widgets.manage',
  );
  const canManageComments = hasStudioCapability(
    input.data.user.roles,
    'comments.manage',
  );
  const canManageNewsletters = hasStudioCapability(
    input.data.user.roles,
    'newsletters.manage',
  );
  const canManageForms = hasStudioCapability(
    input.data.user.roles,
    'forms.manage',
  );
  const canManageMedia = hasStudioCapability(
    input.data.user.roles,
    'media.manage',
  );
  const canManageSettings = hasStudioCapability(
    input.data.user.roles,
    'settings.manage',
  );
  const canPublish = hasStudioCapability(
    input.data.user.roles,
    'publish.manage',
  );
  const canManageImports = hasStudioCapability(
    input.data.user.roles,
    'imports.manage',
  );
  return (
    <StudioSiteIdentityProvider siteTitle={siteIdentity.title}>
      <EdgeIntegrationProvider value={{
        mode: edgeIntegrationMode,
        databaseState: edgeDatabaseState,
        setMode: setEdgeIntegrationMode,
        setDatabaseState: setEdgeDatabaseState,
      }}>
      <StudioToaster />
      <Routes>
      <Route
        element={(
          <StudioShell
            data={input.data}
            siteTitle={siteIdentity.title}
            siteUrl={siteIdentity.url}
            onSessionEnded={onSignedOut}
          />
        )}
      >
        <Route index element={<DashboardPage data={input.data} onSessionEnded={input.onSessionEnded} />} />
        <Route
          path={STUDIO_PATHS.publish}
          element={(
            <DeferredRoute>
              {canPublish ? (
                <PreviewDataPage data={input.data} onSessionEnded={input.onSessionEnded} />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.posts}
          element={(
            <DeferredRoute>
              {canAccessPosts ? (
                <PostsPage
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.newPost}
          element={(
            <DeferredRoute>
              {canAccessPosts ? (
                <PostEditorPage
                  mode="create"
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.postEditor}
          element={(
            <DeferredRoute>
              {canAccessPosts ? (
                <PostEditorPage
                  mode="edit"
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.pages}
          element={(
            <DeferredRoute>
              {canManagePages ? (
                <PagesPage
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.newPage}
          element={(
            <DeferredRoute>
              {canManagePages ? (
                <PageEditorPage
                  mode="create"
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.pageEditor}
          element={(
            <DeferredRoute>
              {canManagePages ? (
                <PageEditorPage
                  mode="edit"
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.authors}
          element={(
            <DeferredRoute>
              {canManageAuthors ? (
                <AuthorsPage
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.taxonomy}
          element={(
            <DeferredRoute>
              {canManageTaxonomies ? (
                <TaxonomyPage
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.menus}
          element={(
            <DeferredRoute>
              {canManageMenus ? (
                <MenusPage
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.widgets}
          element={(
            <DeferredRoute>
              {canManageWidgets ? (
                <WidgetsPage
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.comments}
          element={(
            <DeferredRoute>
              {canManageComments ? (
                edgeIntegrationMode !== 'enabled' ? (
                  <EdgeIntegrationDisabledPage />
                ) : edgeDatabaseState !== 'ready' ? (
                  <EdgeIntegrationUnavailablePage
                    state={edgeDatabaseState}
                    canManageSettings={canManageSettings}
                  />
                ) : (
                  <CommentsPage
                    data={input.data}
                    onSessionEnded={input.onSessionEnded}
                  />
                )
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.newsletters}
          element={(
            <DeferredRoute>
              {canManageNewsletters ? (
                edgeIntegrationMode !== 'enabled' ? (
                  <EdgeIntegrationDisabledPage />
                ) : edgeDatabaseState !== 'ready' ? (
                  <EdgeIntegrationUnavailablePage
                    state={edgeDatabaseState}
                    canManageSettings={canManageSettings}
                  />
                ) : (
                  <NewslettersPage
                    data={input.data}
                    onSessionEnded={input.onSessionEnded}
                  />
                )
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.forms}
          element={(
            <DeferredRoute>
              {canManageForms ? (
                edgeIntegrationMode !== 'enabled' ? (
                  <EdgeIntegrationDisabledPage />
                ) : edgeDatabaseState !== 'ready' ? (
                  <EdgeIntegrationUnavailablePage
                    state={edgeDatabaseState}
                    canManageSettings={canManageSettings}
                  />
                ) : (
                  <FormsPage
                    data={input.data}
                    onSessionEnded={input.onSessionEnded}
                  />
                )
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.media}
          element={(
            <DeferredRoute>
              {canManageMedia ? (
                <MediaPage
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.wxrImport}
          element={(
            <DeferredRoute>
              {canManageImports ? (
                <WxrImportPage
                  data={input.data}
                  onSiteIdentityChanged={setSiteIdentity}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.users}
          element={(
            <DeferredRoute>
              {canManageUsers ? (
                <UserManagementPage
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                  onSignedOut={onSignedOut}
                  onCurrentUserNameChanged={input.onCurrentUserNameChanged}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.studioPreferences}
          element={(
            <DeferredRoute>
              <StudioPreferencesPage />
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.accountSecurity}
          element={(
            <DeferredRoute>
              <AccountSecurityPage
                data={input.data}
                onSessionEnded={input.onSessionEnded}
                onSignedOut={onSignedOut}
              />
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.generalSettings}
          element={(
            <DeferredRoute>
              {canManageSettings ? (
                <GeneralSettingsPage
                  data={input.data}
                  onSiteIdentityChanged={setSiteIdentity}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.interfaceSettings}
          element={(
            <DeferredRoute>
              {canManageSettings ? (
                <StudioInterfaceSettingsPage
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.outputSettings}
          element={(
            <DeferredRoute>
              {canManageSettings ? (
                <OutputSettingsPage
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.brandingSettings}
          element={(
            <DeferredRoute>
              {canManageSettings ? (
                <SiteBrandingPage
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.customCodeSettings}
          element={(
            <DeferredRoute>
              {canManageSettings ? (
                <CustomCodeSettingsPage
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.routingSettings}
          element={(
            <DeferredRoute>
              {canManageSettings ? (
                <RoutingSettingsPage
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.commentSettings}
          element={(
            <DeferredRoute>
              {canManageSettings ? (
                edgeIntegrationMode !== 'enabled' ? (
                  <EdgeIntegrationDisabledPage settingsContext />
                ) : edgeDatabaseState !== 'ready' ? (
                  <EdgeIntegrationUnavailablePage
                    state={edgeDatabaseState}
                    settingsContext
                    canManageSettings={canManageSettings}
                  />
                ) : (
                  <CommentSettingsPage
                    data={input.data}
                    onSessionEnded={input.onSessionEnded}
                  />
                )
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.edgeSecuritySettings}
          element={(
            <DeferredRoute>
              {canManageSettings ? (
                edgeIntegrationMode !== 'enabled' ? (
                  <EdgeIntegrationDisabledPage settingsContext />
                ) : edgeDatabaseState !== 'ready' ? (
                  <EdgeIntegrationUnavailablePage
                    state={edgeDatabaseState}
                    settingsContext
                    canManageSettings={canManageSettings}
                  />
                ) : (
                  <EdgeSecuritySettingsPage
                    data={input.data}
                    onSessionEnded={input.onSessionEnded}
                  />
                )
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.edgeServicesSettings}
          element={(
            <DeferredRoute>
              {canManageSettings ? (
                <EdgeServicesSettingsPage
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.mediaSettings}
          element={(
            <DeferredRoute>
              {canManageSettings ? (
                <MediaSettingsPage
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.newsletterSettings}
          element={(
            <DeferredRoute>
              {canManageSettings ? (
                <NewsletterSettingsPage
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.analytics}
          element={(
            <DeferredRoute>
              {canManageSettings ? (
                <AnalyticsPage onSessionEnded={input.onSessionEnded} />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.analyticsSettings}
          element={(
            <DeferredRoute>
              {canManageSettings ? (
                <AnalyticsSettingsPage
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.publishingSettings}
          element={(
            <DeferredRoute>
              {canManageSettings ? (
                <PublishingSettingsPage
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.mailSettings}
          element={(
            <DeferredRoute>
              {canManageSettings ? (
                <MailSettingsPage
                  data={input.data}
                  onSessionEnded={input.onSessionEnded}
                />
              ) : (
                <StudioAccessDeniedPage />
              )}
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.passwordChange}
          element={(
            <DeferredRoute>
              <PasswordChangePage
                data={input.data}
                onSessionEnded={input.onSessionEnded}
                onSignedOut={onSignedOut}
              />
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.mfaReplace}
          element={(
            <DeferredRoute>
              <MfaManagementPage
                operation="replace_totp"
                data={input.data}
                onSessionEnded={input.onSessionEnded}
              />
            </DeferredRoute>
          )}
        />
        <Route
          path={STUDIO_PATHS.webAuthnCredentials}
          element={(
            <DeferredRoute>
              <WebAuthnManagementPage
                data={input.data}
                onSessionEnded={input.onSessionEnded}
              />
            </DeferredRoute>
          )}
        />
        <Route
          path="*"
          element={(
            <DeferredRoute>
              <StudioNotFoundPage />
            </DeferredRoute>
          )}
        />
      </Route>
      </Routes>
      </EdgeIntegrationProvider>
    </StudioSiteIdentityProvider>
  );
}
