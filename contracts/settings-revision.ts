import { z } from 'zod';

export const SETTINGS_INITIAL_REVISION = '0'.repeat(32);

export const settingsRevisionSchema = z.string()
  .regex(/^[0-9a-f]{32}$/u);
