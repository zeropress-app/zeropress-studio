// jsdom has no visual viewport or canvas rendering. Browser E2E exercises the
// real geometry; these stubs let the editor mount in DOM behavior tests.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: Object.assign(new EventTarget(), {
      width: 1280, height: 800, offsetTop: 0, offsetLeft: 0, scale: 1,
    }),
  });
  globalThis.ResizeObserver ??= class {
    observe() {} unobserve() {} disconnect() {}
  };
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({
      beginPath() {}, arc() {}, fill() {}, fillRect() {}, clearRect() {}, drawImage() {},
      putImageData() {}, createLinearGradient: () => ({ addColorStop() {} }),
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
      createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    }),
  });
}

if (typeof HTMLElement !== 'undefined' && !('innerText' in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true, get() { return this.textContent; },
    set(value: string) { this.textContent = value; },
  });
}

if (typeof document !== 'undefined' && !document.execCommand) {
  document.execCommand = () => false;
}
