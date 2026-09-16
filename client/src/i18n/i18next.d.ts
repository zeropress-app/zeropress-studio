import 'i18next';
import type { StudioResourceContract } from './resources';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    // Namespaces merge later at runtime, but type keys from the complete catalog
    // so misspellings remain compile-time errors.
    resources: StudioResourceContract;
  }
}
