import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { hasStudioCapability } from '../../../contracts/authorization';
import { requestCommentSettings } from '../lib/comment-settings-client';
import { STUDIO_PATHS } from '../routing/studio-routes';
import { useEdgeIntegration } from '../EdgeIntegrationContext';

type RuntimeState =
  | 'loading'
  | 'active'
  | 'disabled'
  | 'integrationDisabled'
  | 'unconfigured'
  | 'unavailable';

/**
 * Map states to semantic tones. Callers provide a label for each state so color is not the sole
 * distinction (WCAG 1.4.1).
 */
const RUNTIME_TONES: Record<RuntimeState, 'muted' | 'positive' | 'attention'> = {
  loading: 'muted',
  active: 'positive',
  disabled: 'attention',
  integrationDisabled: 'attention',
  unconfigured: 'attention',
  unavailable: 'muted',
};

export function CommentRuntimeStatus(input: {
  roles: readonly string[];
  onSessionEnded: () => void;
  copy: Record<RuntimeState, string> & {
    settingsLink: string;
    edgeServicesLink: string;
  };
}) {
  const { mode } = useEdgeIntegration();
  const [state, setState] = useState<RuntimeState>('loading');

  useEffect(() => {
    if (mode === 'disabled') {
      setState('integrationDisabled');
      return undefined;
    }
    // Session-shaped test and recovery callers can intentionally omit roles.
    // A real authenticated application session always includes them; avoid an
    // unnecessary runtime request when capability context is unavailable.
    if (input.roles.length === 0) {
      setState('unavailable');
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    void requestCommentSettings(controller.signal).then((response) => {
      if (!active) return;
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setState('unavailable');
        return;
      }
      if (!response.data.settings.api_base_url) {
        setState('unconfigured');
      } else if (!response.data.settings.enabled) {
        setState('disabled');
      } else {
        setState('active');
      }
    }).catch(() => {
      if (active && !controller.signal.aborted) setState('unavailable');
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [input.onSessionEnded, input.roles.length, mode]);

  return (
    <small
      className={`content-editor-comment-status content-editor-comment-status-${
        RUNTIME_TONES[state]}`}
    >
      {input.copy[state]}
      {state === 'integrationDisabled'
        && hasStudioCapability(input.roles, 'settings.manage') ? (
          <>
            {' '}
            <Link to={STUDIO_PATHS.edgeServicesSettings}>
              {input.copy.edgeServicesLink}
            </Link>
          </>
        ) : null}
      {(state === 'disabled' || state === 'unconfigured')
        && hasStudioCapability(input.roles, 'settings.manage') ? (
          <>
            {' '}
            <Link to={STUDIO_PATHS.commentSettings}>
              {input.copy.settingsLink}
            </Link>
          </>
        ) : null}
    </small>
  );
}
