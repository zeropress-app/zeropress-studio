import { useTranslation } from 'react-i18next';
import { matchPath, NavLink, useLocation, useNavigate } from 'react-router';
import {
  AlertOctagon,
  Cloud,
  Database,
  Gauge,
  KeyRound,
  ShieldCheck,
} from 'lucide-react';
import { Field, StatusPill, StudioIcon } from '../components/primitives';
import {
  OPERATIONS_PATHS,
  type OperationsSection,
} from './operations-routes';

const SECTIONS = [
  { key: 'overview', icon: Gauge, end: true },
  { key: 'access', icon: ShieldCheck, end: false },
  { key: 'database', icon: Database, end: false },
  { key: 'edge', icon: Cloud, end: false },
  { key: 'recovery', icon: KeyRound, end: false },
  { key: 'danger', icon: AlertOctagon, end: false },
] as const satisfies ReadonlyArray<{
  key: OperationsSection;
  icon: typeof Gauge;
  end: boolean;
}>;

export function OperationsNavigation({
  disabled = false,
  databaseUpgradeRequired = false,
}: {
  disabled?: boolean;
  databaseUpgradeRequired?: boolean;
}) {
  const { t } = useTranslation('operations');
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const current = SECTIONS.find((section) => matchPath({
    path: OPERATIONS_PATHS[section.key],
    end: section.end,
  }, pathname)) ?? SECTIONS[0];

  return (
    <nav className="operations-navigation" aria-label={t('navigation.label')}>
      <div className="operations-navigation-picker">
        <Field
          label={t('navigation.pickerLabel')}
          labelHidden
          leading={<StudioIcon icon={current.icon} />}
        >
          {(control) => (
            <select
              {...control}
              value={OPERATIONS_PATHS[current.key]}
              disabled={disabled}
              onChange={(event) => void navigate(event.target.value)}
            >
              {SECTIONS.map((section) => (
                <option
                  key={section.key}
                  value={OPERATIONS_PATHS[section.key]}
                >
                  {t(`navigation.${section.key}.label`)}
                  {section.key === 'database' && databaseUpgradeRequired
                    ? ` · ${t('summary.databaseStates.upgrade_required')}`
                    : ''}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <ul className="operations-navigation-sections">
        {SECTIONS.map((section) => (
          <li key={section.key}>
            <NavLink
              to={OPERATIONS_PATHS[section.key]}
              end={section.end}
              aria-disabled={disabled || undefined}
              className={section.key === 'database' && databaseUpgradeRequired
                ? 'operations-navigation-attention'
                : undefined}
            >
              <StudioIcon
                icon={section.icon}
                className="operations-navigation-icon"
              />
              <span className="operations-navigation-copy">
                <span className="operations-navigation-label">
                  {t(`navigation.${section.key}.label`)}
                </span>
                <span className="operations-navigation-description">
                  {t(`navigation.${section.key}.description`)}
                </span>
                {section.key === 'database' && databaseUpgradeRequired ? (
                  <StatusPill tone="attention">
                    {t('summary.databaseStates.upgrade_required')}
                  </StatusPill>
                ) : null}
              </span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
