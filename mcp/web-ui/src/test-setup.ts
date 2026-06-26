import '@testing-library/jest-dom';

// jsdom doesn't implement ResizeObserver; radix's Checkbox + Popper need it.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // @ts-expect-error -- polyfill for test environment
  globalThis.ResizeObserver = ResizeObserverMock;
}

if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  class WindowResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // @ts-expect-error -- polyfill for test environment
  window.ResizeObserver = WindowResizeObserverMock;
}

// jsdom doesn't implement Element.prototype.scrollIntoView; Radix Select uses
// it to bring the highlighted item into view on open. Polyfill per-project.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}
