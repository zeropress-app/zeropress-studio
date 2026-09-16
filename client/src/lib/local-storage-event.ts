/**
 * Identify a particular localStorage change from another same-origin document.
 *
 * Browsers do not send storage events to the document making the change, avoiding feedback between
 * local setters and cross-tab synchronization. Accept synthetic events without storageArea to
 * preserve the key contract in restricted browsers and tests.
 */
export function isLocalStorageChange(
  event: StorageEvent,
  key: string,
): boolean {
  if (event.key !== key) return false;
  if (event.storageArea === null) return true;

  try {
    return event.storageArea === globalThis.localStorage;
  } catch {
    return false;
  }
}
