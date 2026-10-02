import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { provenance } from './vite-provenance.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const vendor = `${repoRoot}vendor/moss/packages`;

export default defineConfig({
  plugins: [cloudflare({ viteEnvironment: { name: 'ssr' } }), tanstackStart(), viteReact(), provenance(repoRoot)],
  resolve: {
    // moss's aliases in moss's order (A§2), for vendored code and for host code that imports it.
    alias: [
      { find: /^@moss\/shared$/, replacement: `${vendor}/shared/src/index.ts` },
      { find: /^@moss\/shared\/(.*)$/, replacement: `${vendor}/shared/src/$1` },
      { find: /^@\/(.*)$/, replacement: `${vendor}/shared/src/$1` },
      { find: /^@moss-desktop\/(.*)$/, replacement: `${vendor}/desktop/src/$1` },
    ],
    dedupe: ['react', 'react-dom', 'jotai', 'jotai-family', 'lexical', 'yjs', 'prismjs'],
  },
});
