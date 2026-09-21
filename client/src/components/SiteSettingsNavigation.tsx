import { useTranslation } from 'react-i18next';
import { matchPath, NavLink, useLocation, useNavigate } from 'react-router';
import {
  ChartNoAxesCombined,
  Code2,
  ExternalLink,
  Image,
  Languages,
  Mail,
  Palette,
  Route,
  Settings,
  SlidersHorizontal,
} from 'lucide-react';
import { STUDIO_PATHS } from '../routing/studio-routes';
import { Field, StudioIcon } from './primitives';

const SECTIONS = [
  { path: STUDIO_PATHS.generalSettings, key: 'general', icon: Settings },
  { path: STUDIO_PATHS.analyticsSettings, key: 'analytics', icon: ChartNoAxesCombined },
  { path: STUDIO_PATHS.interfaceSettings, key: 'interface', icon: Languages },
  { path: STUDIO_PATHS.brandingSettings, key: 'branding', icon: Palette },
  { path: STUDIO_PATHS.mediaSettings, key: 'media', icon: Image },
  { path: STUDIO_PATHS.outputSettings, key: 'output', icon: SlidersHorizontal },
  { path: STUDIO_PATHS.routingSettings, key: 'routing', icon: Route },
  { path: STUDIO_PATHS.customCodeSettings, key: 'customCode', icon: Code2 },
  { path: STUDIO_PATHS.newsletterSettings, key: 'newsletter', icon: Mail },
] as const;

export function SiteSettingsNavigation() {
  const { t } = useTranslation('settings');
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const current = SECTIONS.find((section) => matchPath(section.path, pathname))
    ?? SECTIONS[0];

  return (
    <nav
      className="site-settings-navigation"
      aria-label={t('navigation.siteLabel')}
    >
      <div className="site-settings-picker">
        <Field
          label={t('navigation.section')}
          labelHidden
          leading={<StudioIcon icon={current.icon} />}
        >
          {(control) => (
            <select
              {...control}
              value={current.path}
              onChange={(event) => {
                // Navigation uses the same router blocker as the desktop links.
                // The selected value follows the route, not an unsaved attempt.
                void navigate(event.target.value);
              }}
            >
              {SECTIONS.map((section) => (
                <option key={section.path} value={section.path}>
                  {t(`navigation.${section.key}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <ul className="site-settings-sections">
        {SECTIONS.map((section) => (
          <li key={section.path}>
            <NavLink
              to={section.path}
              aria-label={t(`navigation.${section.key}`)}
            >
              <StudioIcon icon={section.icon} className="site-settings-section-icon" />
              <span className="site-settings-section-copy">
                <span className="site-settings-section-label">
                  {t(`navigation.${section.key}`)}
                </span>
                <span className="site-settings-section-description">
                  {t(`navigation.descriptions.${section.key}`)}
                </span>
              </span>
            </NavLink>
          </li>
        ))}
      </ul>
      <NavLink
        className="site-settings-operations"
        to="/system/operations"
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t('navigation.operationsNewWindow')}
      >
        {t('navigation.operations')}
        <StudioIcon icon={ExternalLink} className="site-settings-section-icon" />
      </NavLink>
    </nav>
  );
}
