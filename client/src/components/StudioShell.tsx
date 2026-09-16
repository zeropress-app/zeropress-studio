import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ClipboardList,
  ExternalLink,
  Files,
  Images,
  Import,
  LayoutDashboard,
  ListTree,
  LogOut,
  Mail,
  Menu,
  MessagesSquare,
  Newspaper,
  PackageCheck,
  PanelLeftClose,
  PanelLeftOpen,
  PanelsTopLeft,
  Settings,
  ShieldCheck,
  Tags,
  UserRoundPen,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
} from 'react-router';
import type { CurrentSessionSuccess } from '../../../contracts/session';
import { hasStudioCapability } from '../../../contracts/authorization';
import { SYSTEM_ROLE_KEYS } from '../../../contracts/users';
import {
  requestLogout,
  SessionClientError,
  type SessionClientErrorCode,
} from '../lib/session-client';
import {
  persistSidebarCollapsed,
  readInitialSidebarCollapsed,
} from '../lib/sidebar-preference';
import {
  STUDIO_ACCOUNT_NAVIGATION,
  STUDIO_PATHS,
  STUDIO_PRIMARY_NAVIGATION,
  type StudioNavigationIcon,
  type StudioRouteDefinition,
} from '../routing/studio-routes';
import { ThemeSwitcher } from './ThemeSwitcher';
import { LogoBadge } from './LogoBadge';
import {
  PageHeaderRegistrationContext,
  type PageHeaderRegistration,
} from './page-header-registration';
import {
  Button,
  Dialog,
  Notice,
  StudioIcon,
} from './primitives';
import { modalLayer } from './primitives/modal-layer';
import { useDialogBehavior } from './primitives/use-dialog-behavior';
import { STUDIO_VERSION } from '../studio-version';
import { IdentityAvatar } from './IdentityAvatar';
import { useStudioInterfaceSettings } from '../StudioInterfaceSettingsContext';
import { useEdgeIntegration } from '../EdgeIntegrationContext';

type StudioSession = CurrentSessionSuccess['data'];

type LogoutFailure =
  | { kind: 'api' }
  | { kind: 'client'; code: SessionClientErrorCode }
  | { kind: 'unexpected' };

type SidebarTooltipTarget = {
  anchor: HTMLElement;
  key: string;
  label: string;
};

type SidebarTooltipController = {
  active: SidebarTooltipTarget | null;
  id: string;
  position: { left: number; top: number } | null;
  onBlur: (event: ReactFocusEvent<HTMLElement>) => void;
  onFocus: (
    event: ReactFocusEvent<HTMLElement>,
    label: string,
    key: string,
  ) => void;
  onPointerEnter: (
    event: ReactPointerEvent<HTMLElement>,
    label: string,
    key: string,
  ) => void;
  onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => void;
  onTooltipPointerEnter: () => void;
  onTooltipPointerLeave: () => void;
  reset: () => void;
  show: (target: SidebarTooltipTarget) => void;
};

const SIDEBAR_TOOLTIP_OFFSET_PX = 10;
const SIDEBAR_TOOLTIP_EDGE_GUTTER_PX = 24;
const SIDEBAR_TOOLTIP_POINTER_BRIDGE_MS = 100;

/**
 * Studio owns collapsed-sidebar tooltips instead of relying on native title UI. Keep one floating
 * tooltip so a previous keyboard-focus description does not remain while the pointer moves to
 * another icon.
 */
function useSidebarTooltip(enabled: boolean): SidebarTooltipController {
  const id = useId();
  const [active, setActive] = useState<SidebarTooltipTarget | null>(null);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const hoveredRef = useRef<SidebarTooltipTarget | null>(null);
  const focusedRef = useRef<SidebarTooltipTarget | null>(null);
  const tooltipHoveredRef = useRef(false);
  const dismissedRef = useRef(false);
  const pointerBridgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const clearPointerBridgeTimer = useCallback(() => {
    if (pointerBridgeTimerRef.current === null) return;
    clearTimeout(pointerBridgeTimerRef.current);
    pointerBridgeTimerRef.current = null;
  }, []);

  const updatePosition = useCallback((target: SidebarTooltipTarget) => {
    if (!target.anchor.isConnected) {
      setActive(null);
      setPosition(null);
      return;
    }
    const rect = target.anchor.getBoundingClientRect();
    const center = rect.top + rect.height / 2;
    const viewportBottom = Math.max(
      SIDEBAR_TOOLTIP_EDGE_GUTTER_PX,
      window.innerHeight - SIDEBAR_TOOLTIP_EDGE_GUTTER_PX,
    );
    setPosition({
      left: Math.round(rect.right + SIDEBAR_TOOLTIP_OFFSET_PX),
      top: Math.round(Math.min(
        Math.max(center, SIDEBAR_TOOLTIP_EDGE_GUTTER_PX),
        viewportBottom,
      )),
    });
  }, []);

  const show = useCallback((target: SidebarTooltipTarget) => {
    setActive(target);
    updatePosition(target);
  }, [updatePosition]);

  const reset = useCallback(() => {
    clearPointerBridgeTimer();
    hoveredRef.current = null;
    focusedRef.current = null;
    tooltipHoveredRef.current = false;
    dismissedRef.current = false;
    setActive(null);
    setPosition(null);
  }, [clearPointerBridgeTimer]);

  const onPointerEnter = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    label: string,
    key: string,
  ) => {
    if (!enabled) return;
    clearPointerBridgeTimer();
    dismissedRef.current = false;
    const target = { anchor: event.currentTarget, key, label };
    hoveredRef.current = target;
    show(target);
  }, [clearPointerBridgeTimer, enabled, show]);

  const onPointerLeave = useCallback((
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    if (!enabled) return;
    if (hoveredRef.current?.anchor === event.currentTarget) {
      hoveredRef.current = null;
    }
    clearPointerBridgeTimer();
    pointerBridgeTimerRef.current = setTimeout(() => {
      pointerBridgeTimerRef.current = null;
      if (tooltipHoveredRef.current || dismissedRef.current) return;
      const fallback = focusedRef.current;
      if (fallback) show(fallback);
      else {
        setActive(null);
        setPosition(null);
      }
    }, SIDEBAR_TOOLTIP_POINTER_BRIDGE_MS);
  }, [clearPointerBridgeTimer, enabled, show]);

  const onFocus = useCallback((
    event: ReactFocusEvent<HTMLElement>,
    label: string,
    key: string,
  ) => {
    if (!enabled) return;
    clearPointerBridgeTimer();
    dismissedRef.current = false;
    const target = { anchor: event.currentTarget, key, label };
    focusedRef.current = target;
    show(target);
  }, [clearPointerBridgeTimer, enabled, show]);

  const onBlur = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    if (!enabled) return;
    if (focusedRef.current?.anchor === event.currentTarget) {
      focusedRef.current = null;
    }
    if (dismissedRef.current) {
      setActive(null);
      setPosition(null);
      return;
    }
    const fallback = hoveredRef.current;
    if (fallback) show(fallback);
    else if (!tooltipHoveredRef.current) {
      setActive(null);
      setPosition(null);
    }
  }, [enabled, show]);

  const onTooltipPointerEnter = useCallback(() => {
    clearPointerBridgeTimer();
    tooltipHoveredRef.current = true;
  }, [clearPointerBridgeTimer]);

  const onTooltipPointerLeave = useCallback(() => {
    tooltipHoveredRef.current = false;
    if (dismissedRef.current) return;
    const fallback = focusedRef.current ?? hoveredRef.current;
    if (fallback) show(fallback);
    else {
      setActive(null);
      setPosition(null);
    }
  }, [show]);

  useLayoutEffect(() => {
    if (!enabled || !active) return;
    const reposition = () => updatePosition(active);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [active, enabled, updatePosition]);

  useEffect(() => {
    if (!enabled) {
      reset();
      return;
    }
    return () => clearPointerBridgeTimer();
  }, [clearPointerBridgeTimer, enabled, reset]);

  useEffect(() => {
    if (!enabled || !active) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      clearPointerBridgeTimer();
      dismissedRef.current = true;
      tooltipHoveredRef.current = false;
      setActive(null);
      setPosition(null);
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [active, clearPointerBridgeTimer, enabled]);

  return {
    active,
    id,
    position,
    onBlur,
    onFocus,
    onPointerEnter,
    onPointerLeave,
    onTooltipPointerEnter,
    onTooltipPointerLeave,
    reset,
    show,
  };
}

function SidebarTooltip(input: { controller: SidebarTooltipController }) {
  const { active, position } = input.controller;
  if (!active || !position) return null;
  return createPortal((
    <span
      id={input.controller.id}
      className="studio-sidebar-tooltip"
      role="tooltip"
      style={{ left: position.left, top: position.top }}
      onPointerEnter={input.controller.onTooltipPointerEnter}
      onPointerLeave={input.controller.onTooltipPointerLeave}
    >
      {active.label}
    </span>
  ), document.body);
}

const NAVIGATION_ICONS = {
  dashboard: LayoutDashboard,
  publish: PackageCheck,
  posts: Newspaper,
  pages: Files,
  comments: MessagesSquare,
  forms: ClipboardList,
  newsletter: Mail,
  media: Images,
  authors: UserRoundPen,
  menus: ListTree,
  widgets: PanelsTopLeft,
  taxonomy: Tags,
  import: Import,
  users: Users,
  settings: Settings,
  security: ShieldCheck,
} as const satisfies Record<StudioNavigationIcon, LucideIcon>;

function NavigationIcon(input: { icon: StudioNavigationIcon }) {
  return <StudioIcon icon={NAVIGATION_ICONS[input.icon]} />;
}

function StudioNavigation(input: {
  items: readonly StudioRouteDefinition[];
  currentPathname: string;
  /**
   * In the collapsed sidebar, keep labels in the DOM for accessible names while hiding them
   * visually. Show product tooltips on pointer hover and keyboard focus.
   */
  labelsHidden?: boolean;
  onNavigate?: () => void;
  tooltip?: SidebarTooltipController;
}) {
  const { t } = useTranslation('studio');
  const sections = ([
    'overview',
    'content',
    'engagement',
    'site',
    'utility',
  ] as const)
    .map((section) => ({
      section,
      items: input.items.filter(
        (item) => item.navigationSection === section,
      ),
    }))
    .filter(({ items }) => items.length > 0);
  return (
    <nav
      className="studio-sidebar-navigation"
      aria-label={t('navigation.label')}
    >
      {sections.map(({ section, items }) => (
        <div
          className={`studio-navigation-section studio-navigation-section-${section}`}
          key={section}
        >
          <span
            className={input.labelsHidden
              || section === 'overview'
              || section === 'utility'
              ? 'visually-hidden'
              : 'studio-navigation-section-label'}
          >
            {t(`navigation.${section}`)}
          </span>
          <ul>
            {items.map((route) => {
              const currentPathname = input.currentPathname === '/'
                ? '/'
                : input.currentPathname.replace(/\/$/u, '');
              const active = currentPathname === route.path
                || (
                  route.id === 'generalSettings'
                  && currentPathname.startsWith('/settings/site/')
                )
                || (
                  route.id === 'edgeServicesSettings'
                  && currentPathname.startsWith('/settings/edge/')
                )
                || (
                  route.id === 'posts'
                  && currentPathname.startsWith('/posts/')
                )
                || (
                  route.id === 'pages'
                  && currentPathname.startsWith('/pages/')
                );
              const label = t(route.labelKey);
              return (
                <li key={route.id}>
                  <Link
                    to={route.path}
                    className={active ? 'active' : undefined}
                    aria-current={active ? 'page' : undefined}
                    aria-describedby={input.labelsHidden
                      && input.tooltip?.active?.key === route.id
                      ? input.tooltip.id
                      : undefined}
                    onPointerEnter={(event) => {
                      input.tooltip?.onPointerEnter(event, label, route.id);
                    }}
                    onPointerLeave={input.tooltip?.onPointerLeave}
                    onFocus={(event) => {
                      input.tooltip?.onFocus(event, label, route.id);
                    }}
                    onBlur={input.tooltip?.onBlur}
                    onClick={input.onNavigate}
                  >
                    <NavigationIcon icon={route.icon} />
                    <span
                      className={input.labelsHidden
                        ? 'visually-hidden'
                        : undefined}
                    >
                      {label}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function StudioBrand(input: { nameHidden?: boolean } = {}) {
  const { t } = useTranslation('studio');
  return (
    <Link
      className="studio-brand"
      to={STUDIO_PATHS.dashboard}
      aria-label={t('brand.homeLabel')}
    >
      <LogoBadge />
      <span
        className={input.nameHidden ? 'visually-hidden' : 'studio-brand-name'}
      >
        ZeroPress <strong className="studio-brand-emphasis">Studio</strong>
      </span>
    </Link>
  );
}

/**
 * Mobile navigation drawer.
 *
 * This left-side panel has its own appearance but shares Dialog's focus-trap and Escape hook so
 * modal behavior remains consistent.
 */
function StudioMobileNavigation(input: {
  items: readonly StudioRouteDefinition[];
  currentPathname: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('studio');
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useDialogBehavior({
    open: true,
    busy: false,
    onClose: input.onClose,
    dialogRef: drawerRef,
    initialFocusRef: closeRef,
  });

  // Portal the drawer into the same modal layer as Dialog.
  // Leaving it inside the shell would make the drawer itself inert.
  return createPortal((
    <div
      className="studio-mobile-navigation-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) input.onClose();
      }}
    >
      <section
        id="studio-mobile-navigation"
        ref={drawerRef}
        className="studio-mobile-navigation"
        role="dialog"
        aria-modal="true"
        aria-label={t('mobileNavigation.label')}
      >
        <div className="studio-mobile-navigation-header">
          <StudioBrand />
          <button
            ref={closeRef}
            type="button"
            aria-label={t('mobileNavigation.close')}
            onClick={input.onClose}
          >
            <StudioIcon icon={X} />
          </button>
        </div>
        <StudioNavigation
          items={input.items}
          currentPathname={input.currentPathname}
          onNavigate={input.onClose}
        />
      </section>
    </div>
  ), modalLayer());
}

export function StudioShell(input: {
  data: StudioSession;
  siteTitle?: string;
  siteUrl?: string;
  onSessionEnded: () => void;
}) {
  const { mode: edgeIntegrationMode } = useEdgeIntegration();
  const { t } = useTranslation('studio');
  const { settings: interfaceSettings } = useStudioInterfaceSettings();
  const location = useLocation();
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] =
    useState(readInitialSidebarCollapsed);
  const sidebarTooltip = useSidebarTooltip(sidebarCollapsed);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutFailure, setLogoutFailure] =
    useState<LogoutFailure | null>(null);
  const [pageHeader, setPageHeader] =
    useState<PageHeaderRegistration | null>(null);
  const accountRegionRef = useRef<HTMLDivElement>(null);
  const accountButtonRef = useRef<HTMLButtonElement>(null);
  const logoutCancelRef = useRef<HTMLButtonElement>(null);
  const siteTitle = input.siteTitle ?? input.data.site_title ?? '';
  const siteUrl = input.siteUrl ?? input.data.site_url ?? '';
  // Use the collapse button's visible label as its accessible name as well.
  // A separate aria-label could diverge from the visible text.
  const sidebarToggleLabel = sidebarCollapsed
    ? t('sidebar.expand')
    : t('sidebar.collapse');
  const accountRoleLabel = SYSTEM_ROLE_KEYS
    .filter((role) => input.data.user.roles.includes(role))
    .map((role) => t(`account.roles.${role}`))
    .join(' · ') || t('account.roles.unknown');
  const primaryNavigation = STUDIO_PRIMARY_NAVIGATION.filter((route) => (
    !(
      edgeIntegrationMode === 'disabled'
      && ['comments', 'forms', 'newsletters'].includes(route.id)
    )
    && (
      route.requiredCapability === null
      || hasStudioCapability(
        input.data.user.roles,
        route.requiredCapability,
      )
    )
  ));
  const accountNavigation = STUDIO_ACCOUNT_NAVIGATION.filter((route) => (
    route.id !== 'studioPreferences'
    || interfaceSettings.enabled_locales.length > 1
  ));

  // Resizing while the expanded collapse button has focus does not fire focus again.
  // Open its tooltip as soon as the collapsed DOM is committed.
  useLayoutEffect(() => {
    if (!sidebarCollapsed) return;
    const focused = document.activeElement;
    if (
      !(focused instanceof HTMLElement)
      || !focused.classList.contains('studio-sidebar-toggle')
    ) return;
    sidebarTooltip.show({
      anchor: focused,
      key: 'sidebar-toggle',
      label: sidebarToggleLabel,
    });
  }, [sidebarCollapsed, sidebarToggleLabel, sidebarTooltip.show]);

  const registerPageHeader = useCallback(
    (registration: PageHeaderRegistration) => {
      setPageHeader(registration);
    },
    [],
  );
  const unregisterPageHeader = useCallback((id: symbol) => {
    setPageHeader((current) => current?.id === id ? null : current);
  }, []);
  const pageHeaderRegistry = useMemo(() => ({
    register: registerPageHeader,
    unregister: unregisterPageHeader,
  }), [registerPageHeader, unregisterPageHeader]);

  useEffect(() => {
    setMobileNavigationOpen(false);
    setAccountMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!accountMenuOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node
        && !accountRegionRef.current?.contains(event.target)
      ) {
        setAccountMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setAccountMenuOpen(false);
      accountButtonRef.current?.focus();
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [accountMenuOpen]);

  function toggleSidebar() {
    setSidebarCollapsed((collapsed) => {
      persistSidebarCollapsed(!collapsed);
      return !collapsed;
    });
  }

  function closeLogout() {
    setLogoutOpen(false);
    setLogoutFailure(null);
  }

  function openLogout() {
    setAccountMenuOpen(false);
    setLogoutFailure(null);
    setLogoutOpen(true);
  }

  async function confirmLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutFailure(null);
    try {
      const response = await requestLogout(input.data.csrf_token);
      if (
        !response.success
        && response.error.code !== 'AUTHENTICATION_REQUIRED'
      ) {
        setLogoutFailure({ kind: 'api' });
        return;
      }
      input.onSessionEnded();
    } catch (error) {
      setLogoutFailure(
        error instanceof SessionClientError
          ? { kind: 'client', code: error.code }
          : { kind: 'unexpected' },
      );
    } finally {
      setLoggingOut(false);
    }
  }

  function logoutErrorMessage(): string | null {
    if (!logoutFailure) return null;
    if (logoutFailure.kind === 'api') return t('logout.errors.api');
    if (logoutFailure.kind === 'unexpected') {
      return t('logout.errors.unexpected');
    }
    if (logoutFailure.code === 'TIMEOUT') {
      return t('logout.errors.timeout');
    }
    if (logoutFailure.code === 'NETWORK_ERROR') {
      return t('logout.errors.network');
    }
    return t('logout.errors.invalidResponse');
  }

  const errorMessage = logoutErrorMessage();

  return (
    <div
      className={sidebarCollapsed
        ? 'studio-shell studio-shell-collapsed'
        : 'studio-shell'}
    >
      <a className="studio-skip-link" href="#studio-main-content">
        {t('accessibility.skipToContent')}
      </a>

      <aside className="studio-sidebar" id="studio-sidebar">
        <StudioBrand nameHidden={sidebarCollapsed} />
        <StudioNavigation
          items={primaryNavigation}
          currentPathname={location.pathname}
          labelsHidden={sidebarCollapsed}
          tooltip={sidebarTooltip}
          onNavigate={sidebarTooltip.reset}
        />
        <div className="studio-sidebar-footer">
          <button
            className="studio-sidebar-toggle"
            type="button"
            aria-expanded={!sidebarCollapsed}
            aria-controls="studio-sidebar"
            aria-describedby={sidebarTooltip.active?.key === 'sidebar-toggle'
              ? sidebarTooltip.id
              : undefined}
            onPointerEnter={(event) => {
              sidebarTooltip.onPointerEnter(
                event,
                sidebarToggleLabel,
                'sidebar-toggle',
              );
            }}
            onPointerLeave={sidebarTooltip.onPointerLeave}
            onFocus={(event) => {
              sidebarTooltip.onFocus(
                event,
                sidebarToggleLabel,
                'sidebar-toggle',
              );
            }}
            onBlur={sidebarTooltip.onBlur}
            onClick={toggleSidebar}
          >
            <StudioIcon
              icon={sidebarCollapsed ? PanelLeftOpen : PanelLeftClose}
            />
            <span className={sidebarCollapsed ? 'visually-hidden' : undefined}>
              {sidebarToggleLabel}
            </span>
          </button>
        </div>
      </aside>

      <SidebarTooltip controller={sidebarTooltip} />

      <div className="studio-workspace">
        <header className="studio-topbar">
          <button
            className="studio-mobile-menu-button"
            type="button"
            aria-label={t('mobileNavigation.open')}
            aria-expanded={mobileNavigationOpen}
            aria-controls="studio-mobile-navigation"
            onClick={() => setMobileNavigationOpen(true)}
          >
            <StudioIcon icon={Menu} />
          </button>
          <div className="studio-page-context">
            {pageHeader ? (
              <>
                <h1
                  className="studio-page-context-title"
                  id={pageHeader.titleId}
                >
                  {pageHeader.title}
                </h1>
                {pageHeader.description ? (
                  <p className="studio-page-context-description">
                    {pageHeader.description}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
          <div className="studio-topbar-actions">
            {siteTitle ? (
              <span className="studio-site-title" title={siteTitle}>
                {siteTitle}
              </span>
            ) : null}
            {siteUrl ? (
              <a
                className="studio-visit-site"
                href={siteUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span>{t('site.visit')}</span>
                <StudioIcon icon={ExternalLink} />
              </a>
            ) : null}
            <div className="studio-account-region" ref={accountRegionRef}>
              <button
                ref={accountButtonRef}
                className="studio-account-button"
                type="button"
                aria-expanded={accountMenuOpen}
                aria-controls="studio-account-menu"
                aria-label={t('account.openMenu', {
                  name: input.data.user.name,
                })}
                onClick={() => setAccountMenuOpen((value) => !value)}
              >
                <IdentityAvatar
                  className="studio-account-avatar"
                  name={input.data.user.name}
                  src={input.data.user.avatar_preview_url}
                />
                <span className="studio-account-button-copy">
                  <strong className="studio-account-name">
                    {input.data.user.name}
                  </strong>
                </span>
                <StudioIcon icon={ChevronDown} />
              </button>

              {accountMenuOpen ? (
                <div
                  id="studio-account-menu"
                  className="studio-account-menu"
                >
                  <div className="studio-account-menu-identity">
                    <strong className="studio-account-identity-name">
                      {input.data.user.name}
                    </strong>
                    <span className="studio-account-identity-role">
                      {accountRoleLabel}
                    </span>
                  </div>
                  <nav aria-label={t('account.navigationLabel')}>
                    {accountNavigation.map((route) => (
                      <NavLink
                        key={route.id}
                        to={route.path}
                        end={route.end}
                      >
                        <NavigationIcon icon={route.icon} />
                        <span>{t(route.labelKey)}</span>
                      </NavLink>
                    ))}
                  </nav>
                  <ThemeSwitcher />
                  <button
                    className="studio-account-logout"
                    type="button"
                    onClick={openLogout}
                  >
                    <StudioIcon icon={LogOut} />
                    <span>{t('logout.open')}</span>
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <PageHeaderRegistrationContext.Provider value={pageHeaderRegistry}>
          <div className="studio-route-content">
            <Outlet />
          </div>
        </PageHeaderRegistrationContext.Provider>

        {/*
         * All shell ancestors are div elements, so this footer is a contentinfo landmark. Its full
         * product label remains available independently of the sidebar width.
         */}
        <footer className="studio-footer">
          <p className="studio-footer-version">
            {t('brand.versionLabel', { version: STUDIO_VERSION })}
          </p>
        </footer>
      </div>

      {mobileNavigationOpen ? (
        <StudioMobileNavigation
          items={primaryNavigation}
          currentPathname={location.pathname}
          onClose={() => setMobileNavigationOpen(false)}
        />
      ) : null}

      <Dialog
        open={logoutOpen}
        onClose={closeLogout}
        busy={loggingOut}
        kicker={t('logout.kicker')}
        title={t('logout.title')}
        description={t('logout.description')}
        initialFocusRef={logoutCancelRef}
        // The sign-out trigger lives in the account menu and disappears when the dialog opens.
        // Restore focus to the account button, which remains present.
        returnFocusRef={accountButtonRef}
        actions={(
          <>
            <Button
              ref={logoutCancelRef}
              type="button"
              disabled={loggingOut}
              onClick={closeLogout}
            >
              {t('logout.cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={loggingOut}
              onClick={() => void confirmLogout()}
            >
              {loggingOut ? t('logout.running') : t('logout.confirm')}
            </Button>
          </>
        )}
      >
        {errorMessage ? (
          <div className="studio-dialog-notice">
            <Notice tone="error">
              {errorMessage}
            </Notice>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
