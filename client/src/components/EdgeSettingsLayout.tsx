import type { ReactNode } from 'react';
import { EdgeSettingsNavigation } from './EdgeSettingsNavigation';

/**
 * Shared navigation and content layout for Edge settings.
 *
 * The overview belongs with Comments, Request Security, and Mail even though it is not a revision
 * form. Share only navigation and layout here; each screen and SettingsScreen retain ownership of
 * reading and saving.
 */
export function EdgeSettingsLayout(input: { children: ReactNode }) {
  return (
    <div className="edge-settings-layout">
      <EdgeSettingsNavigation />
      <div className="edge-settings-content">{input.children}</div>
    </div>
  );
}
