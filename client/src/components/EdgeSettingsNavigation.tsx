import { useTranslation } from 'react-i18next';
import { matchPath, NavLink, useLocation, useNavigate } from 'react-router';
import {
  Activity,
  ExternalLink,
  Mail,
  MessageSquareText,
  ShieldCheck,
} from 'lucide-react';
import { useEdgeIntegration } from '../EdgeIntegrationContext';
import { STUDIO_PATHS } from '../routing/studio-routes';
import { Field, StudioIcon } from './primitives';

const SECTIONS = [
  {
    path: STUDIO_PATHS.edgeServicesSettings,
    key: 'edgeOverview',
    descriptionKey: 'overview',
    icon: Activity,
    requiresIntegration: false,
  },
  {
    path: STUDIO_PATHS.commentSettings,
    key: 'comments',
    descriptionKey: 'comments',
    icon: MessageSquareText,
    requiresIntegration: true,
  },
  {
    path: STUDIO_PATHS.edgeSecuritySettings,
    key: 'requestSecurity',
    descriptionKey: 'requestSecurity',
    icon: ShieldCheck,
    requiresIntegration: true,
  },
  {
    path: STUDIO_PATHS.mailSettings,
    key: 'mail',
    descriptionKey: 'mail',
    icon: Mail,
    requiresIntegration: false,
  },
] as const;

/**
 * Navigate the Edge runtime and Studio's delivery integration together.
 *
 * Keep the integration entry point and mail-provider settings available while integration is
 * disabled. Hide links that require EDGE_DB so intentionally disabled features do not appear
 * broken.
 */
export function EdgeSettingsNavigation() {
  const { t } = useTranslation('settings');
  const { mode } = useEdgeIntegration();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const sections = SECTIONS.filter((section) => (
    !section.requiresIntegration || mode === 'enabled'
  ));
  const current = sections.find((section) => matchPath(section.path, pathname))
    ?? sections[0];

  return (
    <nav
      className="edge-settings-navigation"
      aria-label={t('navigation.edgeLabel')}
    >
      <div className="edge-settings-picker">
        <Field
          label={t('navigation.edgeSection')}
          labelHidden
          leading={<StudioIcon icon={current.icon} />}
        >
          {(control) => (
            <select
              {...control}
              value={current.path}
              onChange={(event) => {
                // The router blocker continues to own unsaved-change decisions.
                void navigate(event.target.value);
              }}
            >
              {sections.map((section) => (
                <option key={section.path} value={section.path}>
                  {t(`navigation.${section.key}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <ul className="edge-settings-sections">
        {sections.map((section) => (
          <li key={section.path}>
            <NavLink
              to={section.path}
              end
              aria-label={t(`navigation.${section.key}`)}
            >
              <StudioIcon icon={section.icon} className="edge-settings-section-icon" />
              <span className="edge-settings-section-copy">
                <span className="edge-settings-section-label">
                  {t(`navigation.${section.key}`)}
                </span>
                <span className="edge-settings-section-description">
                  {t(`navigation.edgeDescriptions.${section.descriptionKey}`)}
                </span>
              </span>
            </NavLink>
          </li>
        ))}
      </ul>
      <NavLink
        className="edge-settings-operations"
        to="/system/operations"
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t('navigation.operationsNewWindow')}
      >
        {t('navigation.operations')}
        <StudioIcon icon={ExternalLink} className="edge-settings-section-icon" />
      </NavLink>
    </nav>
  );
}
