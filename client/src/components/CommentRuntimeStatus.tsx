import { requestEdgeUrlSettings } from '../lib/edge-url-client';
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
    void Promise.all([requestCommentSettings(controller.signal), requestEdgeUrlSettings(controller.signal)]).then(([response, url]) => {
      if (!active) return;
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setState('unavailable');
        return;
      }
      if (!url.success) {
        if (url.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded();
        else setState('unavailable');
        return;
      }
      if (!url.data.settings.edge_origin) {
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
            <Link to={state === 'unconfigured' ? `${STUDIO_PATHS.edgeServicesSettings}#edge-url` : STUDIO_PATHS.commentSettings}>
              {state === 'unconfigured' ? input.copy.edgeServicesLink : input.copy.settingsLink}
            </Link>
          </>
        ) : null}
    </small>
  );
}
