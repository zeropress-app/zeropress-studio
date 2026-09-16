export const SIDEBAR_COLLAPSED_STORAGE_KEY =
  'zeropress-studio.sidebar-collapsed';

/**
 * Desktop sidebar collapse preference.
 *
 * Store this display preference in the browser because layout density varies
 * by device. A server setting would also require revision and capability
 * contracts. Collapsing must still work when persistence is unavailable.
 */
export function readInitialSidebarCollapsed(): boolean {
  try {
    return globalThis.localStorage
      ?.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    // Storage may be unavailable in privacy-restricted contexts.
    return false;
  }
}

export function persistSidebarCollapsed(collapsed: boolean): void {
  try {
    globalThis.localStorage
      ?.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // Collapsing still works for the current session without persistence.
  }
}
