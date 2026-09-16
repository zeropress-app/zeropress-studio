import { z } from 'zod';

/** A same-site public URL produced from the canonical permalink settings. */
export const publicRouteUrlSchema = z.string()
  .min(1)
  .refine((value) => (
    value.startsWith('/')
    && !value.startsWith('//')
    && !value.includes('?')
    && !value.includes('#')
  ));

export type PublicRouteUrl = z.infer<typeof publicRouteUrlSchema>;
