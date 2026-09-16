import { config as configureZod } from 'zod';

/**
 * Studio's browser CSP does not allow `unsafe-eval`.
 *
 * Zod probes object-schema JIT support with `Function("")` by default. Even
 * when it catches the failure, the browser records a CSP violation. Disable
 * JIT before creating schemas. Web Workers have separate globals, so each
 * entry point must import this module directly.
 */
configureZod({ jitless: true });

