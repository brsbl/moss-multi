// The jsdom gaps moss's jest.setup.ts fills, so pristine moss modules load as they do in moss's own tests.
process.env.TZ = 'UTC';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof globalThis.ResizeObserver;
}
if (typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.scrollIntoView !== 'function') {
  HTMLElement.prototype.scrollIntoView = function () {};
}
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollTo !== 'function') {
  Element.prototype.scrollTo = function () {};
}
