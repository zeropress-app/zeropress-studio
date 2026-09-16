import '@testing-library/jest-dom/vitest';
import { loadAllNamespaces } from './i18n';

// Production lazy-route boundaries load their screen catalogs. Tests render
// screen components directly, so preload the complete catalog here
// to keep rendering synchronous.
await loadAllNamespaces();

if (typeof window !== 'undefined') {
  const zeroRect = (): DOMRect => ({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    toJSON: () => ({}),
  });
  if (typeof Range !== 'undefined') {
    Object.defineProperties(Range.prototype, {
      getBoundingClientRect: {
        configurable: true,
        value: zeroRect,
      },
      getClientRects: {
        configurable: true,
        value: () => [] as unknown as DOMRectList,
      },
    });
  }
  if (typeof document.elementFromPoint !== 'function') {
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => null,
    });
  }
}
