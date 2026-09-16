import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { SystemBootstrap } from './SystemBootstrap';
import {
  UserActivationCheckingScreen,
  UserActivationPage,
} from './UserActivationPage';
import {
  InitialCheckingPlaceholder,
  InitialCheckingProvider,
  useInitialCheckingPhase,
} from './components/InitialCheckingGate';
import { StudioCheckingScreen } from './components/StudioCheckingScreen';
import { ensureNamespaces } from './i18n';
import { requestPublicInterfaceConfig } from './lib/studio-interface-settings-client';
import {
  SAFE_INTERFACE_SETTINGS_FALLBACK,
  StudioInterfaceSettingsProvider,
  useStudioInterfaceSettings,
} from './StudioInterfaceSettingsContext';

/**
 * Operations provides administration and recovery outside the regular Studio shell. Load its
 * screen and the Operations and Studio access message catalogs in parallel, and render only after
 * its messages are ready.
 */
const OperationsPage = lazy(async () => {
  const [module] = await Promise.all([
    import('./OperationsPage'),
    ensureNamespaces(['operations', 'accessSettings']),
  ]);
  return { default: module.OperationsPage };
});

const OperationsOverviewPage = lazy(async () => ({
  default: (await import('./operations/OperationsOverviewPage'))
    .OperationsOverviewPage,
}));
const OperationsAccessPage = lazy(async () => ({
  default: (await import('./operations/OperationsAccessPage'))
    .OperationsAccessPage,
}));
const OperationsDatabasePage = lazy(async () => ({
  default: (await import('./operations/OperationsDatabasePage'))
    .OperationsDatabasePage,
}));
const OperationsEdgePage = lazy(async () => ({
  default: (await import('./operations/OperationsEdgePage'))
    .OperationsEdgePage,
}));
const OperationsRecoveryPage = lazy(async () => ({
  default: (await import('./operations/OperationsRecoveryPage'))
    .OperationsRecoveryPage,
}));
const OperationsDangerPage = lazy(async () => ({
  default: (await import('./operations/OperationsDangerPage'))
    .OperationsDangerPage,
}));

/**
 * Frame shown while loading. The shared initial-checking clock keeps only the background visible
 * for the first two seconds, then shows Studio Checking while either the screen chunk or public
 * status check remains pending.
 */
function OperationsPagePending() {
  const { t } = useTranslation('system');
  const checkingPhase = useInitialCheckingPhase(true);

  return checkingPhase === 'hidden'
    ? <InitialCheckingPlaceholder label={t('loading.title')} />
    : <StudioCheckingScreen updateDocumentTitle={false} />;
}

function OperationsRoute() {
  return (
    <Suspense fallback={<OperationsPagePending />}>
      <OperationsPage />
    </Suspense>
  );
}

function OperationalInterfaceConfigBoundary(input: {
  children: ReactNode;
}) {
  const { t } = useTranslation('users');
  const { applyOrganizationSettings } = useStudioInterfaceSettings();
  const [ready, setReady] = useState(false);
  const checkingPhase = useInitialCheckingPhase(!ready);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void (async () => {
      let settings = SAFE_INTERFACE_SETTINGS_FALLBACK;
      try {
        const response = await requestPublicInterfaceConfig(
          controller.signal,
        );
        if (response.success) settings = response.data;
      } catch {
        if (controller.signal.aborted) return;
        // Public account activation remains usable in English if the
        // organization policy cannot be loaded or validated.
      }
      if (!active) return;
      await applyOrganizationSettings(settings);
      if (active) setReady(true);
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [applyOrganizationSettings]);

  if (!ready) {
    return checkingPhase === 'hidden'
      ? <InitialCheckingPlaceholder label={t('activation.loading')} />
      : <UserActivationCheckingScreen />;
  }
  if (checkingPhase === 'checking') {
    return <UserActivationCheckingScreen />;
  }
  return input.children;
}

export default function App(input: { setupToken?: string }) {
  const router = useMemo(() => createBrowserRouter([
    {
      path: '/system/operations',
      element: <OperationsRoute />,
      children: [
        { index: true, element: <OperationsOverviewPage /> },
        { path: 'access', element: <OperationsAccessPage /> },
        { path: 'database', element: <OperationsDatabasePage /> },
        { path: 'edge', element: <OperationsEdgePage /> },
        { path: 'recovery', element: <OperationsRecoveryPage /> },
        { path: 'danger', element: <OperationsDangerPage /> },
        {
          path: '*',
          element: <Navigate to="/system/operations" replace />,
        },
      ],
    },
    {
      path: '/activate',
      element: (
        <OperationalInterfaceConfigBoundary>
          <UserActivationPage setupToken={input.setupToken ?? ''} />
        </OperationalInterfaceConfigBoundary>
      ),
    },
    { path: '*', element: <SystemBootstrap /> },
  ]), [input.setupToken]);
  return (
    <StudioInterfaceSettingsProvider>
      <InitialCheckingProvider>
        <RouterProvider router={router} />
      </InitialCheckingProvider>
    </StudioInterfaceSettingsProvider>
  );
}
