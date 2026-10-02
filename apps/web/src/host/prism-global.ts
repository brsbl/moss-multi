// The one Prism, on the global scope before any module that reads the bare `Prism` global evaluates: moss's
// prism-setup language components and @lexical/code (L§4.1, a chunk-order shift once crashed the deployed app).
import Prism from 'prismjs';

const scope = globalThis as typeof globalThis & { Prism?: typeof Prism };
scope.Prism ??= Prism;

export {};
