import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { LucideIcon } from 'lucide-react';
import type { ContentSearchIndexStatus } from '../../../contracts/content-search-index';
import { StatusPill, StudioIcon, type StatusTone } from './primitives';

export type RuntimeState = 'disabled' | 'unconfigured' | 'needsSetup'
  | ContentSearchIndexStatus['state'];

const TONE: Record<RuntimeState, StatusTone> = {
  ready: 'positive',
  disabled: 'neutral',
  unconfigured: 'neutral',
  needsSetup: 'attention',
  rebuild_required: 'attention',
  in_progress: 'attention',
  recovery_required: 'critical',
  unavailable: 'critical',
};

export function DashboardRuntimeRow(input: {
  label: string;
  icon: LucideIcon;
  state: RuntimeState;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const { t } = useTranslation('dashboard');
  const labelId = useId();
  return (
    <div className="dashboard-runtime-row" role="group" aria-labelledby={labelId}>
      <div className="dashboard-runtime-heading">
        <span className="dashboard-runtime-label" id={labelId}>
          <StudioIcon icon={input.icon} className="dashboard-item-icon" />
          <span>{input.label}</span>
        </span>
        <span role="status" aria-label={input.label}>
          <StatusPill tone={TONE[input.state]}>
            {t(`runtime.states.${input.state}`)}
          </StatusPill>
        </span>
      </div>
      {input.children}
      {input.actions ? <div className="dashboard-runtime-actions">{input.actions}</div> : null}
    </div>
  );
}
