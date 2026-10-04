// ported-from: packages/desktop/src/renderer/editor/plugins/code-block/prism-setup.ts @ 762abb777
/**
 * Prism.js Setup - MUST be imported before any @lexical/code imports
 *
 * This file sets up Prism.js on the global scope so that @lexical/code's
 * PrismTokenizer can find it when it evaluates.
 *
 * Languages must be loaded in dependency order:
 * - clike is required by many languages (c, cpp, java, javascript, etc.)
 * - markup is required by jsx/tsx
 *
 * Note: @lexical/code bundles Objective‑C which extends the `c` grammar,
 * so `prism-c` has to be loaded even if we don't surface that language
 * in the picker.
 */

import Prism from 'prismjs';

// Core languages (many others depend on these)
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-markup'; // HTML/XML - required for JSX/TSX

// Languages that extend clike
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-javascript';

// Languages that extend javascript
import 'prismjs/components/prism-typescript';

// JSX/TSX require markup + javascript/typescript
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';

// Other languages bundled with the editor
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-swift';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-yaml';

// Make Prism available globally before @lexical/code loads
if (typeof window !== 'undefined') {
  (window as Window & { Prism?: typeof Prism }).Prism = Prism;
}
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { Prism?: typeof Prism }).Prism = Prism;
}

export { Prism };
