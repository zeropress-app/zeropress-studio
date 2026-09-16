/**
 * Modal layer.
 *
 * Render modals in a dedicated layer at the end of document.body for two reasons:
 * 1. The rest of the application can become inert without disabling the modal itself or relying on
 * each screen to manage its background.
 * 2. The modal escapes clipping and stacking contexts created by ancestor overflow, transform, and
 * z-index.
 *
 * aria-modal="true" alone is insufficient: support varies, and keyboard focus can still reach
 * background controls. inert blocks focus, pointer input, and accessibility-tree exposure.
 */

const LAYER_CLASS = 'studio-modal-layer';

let layer: HTMLElement | null = null;

/** Modal container, created lazily and reused. */
export function modalLayer(): HTMLElement {
  if (layer?.isConnected) return layer;
  const element = document.createElement('div');
  element.className = LAYER_CLASS;
  document.body.append(element);
  layer = element;
  return element;
}

/**
 * Number of open modals. Nested modals, such as a navigation warning above a save confirmation,
 * keep the background locked until the last one closes.
 */
let openCount = 0;

/**
 * Elements locked by this layer.
 *
 * Preserve elements that were already inert so releasing the layer does not override a screen's
 * own state.
 *
 * Read and write the attribute instead of the element.inert IDL property. This matches React's
 * output and works in environments without the IDL implementation.
 */
let lockedByUs: Element[] = [];

/**
 * Apply aria-hidden alongside inert.
 *
 * inert blocks focus and pointer input, but accessibility-tree support varies. The modal is
 * portaled outside the locked subtree, so its focused elements are never inside aria-hidden.
 */
const HIDDEN_ATTRIBUTES = ['inert', 'aria-hidden'] as const;

/**
 * Make the background inert and return a release function.
 *
 * The modal must be rendered inside this layer. An inline modal would make itself inert.
 */
export function retainBackgroundInert(): () => void {
  openCount += 1;
  if (openCount === 1) {
    const container = modalLayer();
    for (const child of [...document.body.children]) {
      if (child === container) continue;
      if (child.hasAttribute('inert')) continue;
      child.setAttribute('inert', '');
      child.setAttribute('aria-hidden', 'true');
      lockedByUs.push(child);
    }
  }

  let releasedAlready = false;
  return () => {
    // Release may run twice, as during StrictMode effect replay.
    if (releasedAlready) return;
    releasedAlready = true;
    openCount -= 1;
    if (openCount > 0) return;
    for (const child of lockedByUs) {
      for (const name of HIDDEN_ATTRIBUTES) child.removeAttribute(name);
    }
    lockedByUs = [];
  };
}

/** Accessor for inspecting layer state in tests. */
export function modalLayerElement(): HTMLElement | null {
  return layer?.isConnected ? layer : null;
}
