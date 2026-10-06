// The viewer bundle: one ESM entry, one stylesheet and moss's font files in dist/, plus viewer.json recording the
// moss pin, the source commit and the bundle hash. Moss's aliases match apps/web's (A§2); two leaf modules are
// substituted by absolute path (A§2.1), so the vendored files stay byte-identical.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import viteReact from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { readSource } from '../../apps/web/vite-provenance.ts';
import { HTML_FRAME_DOCUMENT } from '../protocol/src/html-frame.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const vendor = `${repoRoot}vendor/moss/packages`;
const editorUtils = `${vendor}/desktop/src/renderer/editor/utils`;
const pkg = JSON.parse(readFileSync(`${here}package.json`, 'utf8')) as { name: string; version: string };

const ENTRY = 'moss-viewer';
/** HTML blocks' sandboxed frame document, which a host serves to run them live (services.htmlFrameUrl). */
const FRAME = `${ENTRY}-frame.html`;
const API = 1;
const SUBSTITUTES: Record<string, string> = {
  [`${editorUtils}/asset-url.ts`]: `${here}src/substitutes/asset-url.ts`,
  [`${editorUtils}/media-server-url.ts`]: `${here}src/substitutes/media-server-url.ts`,
};

/** Serves a substitute's source in place of the vendored module's; `?pristine` still reaches moss's own bytes. */
function substitutes(): Plugin {
  return {
    name: 'moss-viewer-substitutes',
    enforce: 'pre',
    load(id) {
      const file = SUBSTITUTES[id];
      return file ? readFileSync(file, 'utf8') : null;
    },
  };
}

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

function frameDocument(): Plugin {
  return {
    name: 'moss-viewer-frame',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: FRAME, source: HTML_FRAME_DOCUMENT });
    },
  };
}

/** viewer.json: what was built, from which sources, and the hash of every emitted file. */
function manifest(): Plugin {
  return {
    name: 'moss-viewer-manifest',
    apply: 'build',
    writeBundle(options, bundle) {
      const outputs = Object.values(bundle)
        .map((output) => {
          const content = output.type === 'chunk' ? output.code : output.source;
          return { fileName: output.fileName, bytes: typeof content === 'string' ? Buffer.from(content) : Buffer.from(content) };
        })
        .sort((a, b) => (a.fileName < b.fileName ? -1 : 1));
      const digest = createHash('sha256');
      for (const { fileName, bytes } of outputs) digest.update(`${fileName}\0${bytes.length}\0`).update(bytes);
      const ported = JSON.parse(readFileSync(`${repoRoot}vendor/moss/PORTED.json`, 'utf8')) as { upstream: string; pin: string; commit: string };
      const source = readSource(repoRoot);
      const record = {
        name: pkg.name,
        version: pkg.version,
        api: API,
        entry: `${ENTRY}.js`,
        css: `${ENTRY}.css`,
        frame: FRAME,
        moss: { upstream: ported.upstream, pin: ported.pin, commit: ported.commit },
        source: { repo: 'brsbl/moss-multi', commit: source.commit, headSha: source.headSha, dirty: source.dirty, diffHash: source.diffHash },
        bundleHash: digest.digest('hex'),
        files: Object.fromEntries(outputs.map(({ fileName, bytes }) => [fileName, { bytes: bytes.length, sha256: sha256(bytes) }])),
      };
      writeFileSync(`${options.dir}/viewer.json`, `${JSON.stringify(record, null, 2)}\n`);
    },
  };
}

export default defineConfig({
  plugins: [substitutes(), viteReact(), frameDocument(), manifest()],
  // Asset URLs resolve against the bundle's own location, wherever the host serves dist/.
  base: './',
  resolve: {
    alias: [
      { find: /^@moss\/shared$/, replacement: `${vendor}/shared/src/index.ts` },
      { find: /^@moss\/shared\/(.*)$/, replacement: `${vendor}/shared/src/$1` },
      { find: /^@\/(.*)$/, replacement: `${vendor}/shared/src/$1` },
      { find: /^@moss-desktop\/(.*)$/, replacement: `${vendor}/desktop/src/$1` },
      // moss-multi seams in vendored files call host hooks (A§2.2); the viewer reads the same hide registry.
      { find: /^@moss-multi\/host\/(.*)$/, replacement: `${repoRoot}apps/web/src/host/$1` },
      // Substitutes load under the vendored path, so they reach the viewer and moss's own module by alias.
      { find: /^@moss-viewer\/(.*)$/, replacement: `${here}src/$1.ts` },
      { find: /^@moss-pristine\/(.*)$/, replacement: `${editorUtils}/$1.ts?pristine` },
    ],
    dedupe: ['react', 'react-dom', 'jotai', 'jotai-family', 'lexical', 'yjs', 'prismjs'],
  },
  // An app build of a script entry rather than library mode, which would inline every font into the stylesheet.
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    // Fonts stay files beside the stylesheet, as in apps/web, so a host's font-src needs no data: URLs.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
    rolldownOptions: {
      input: `${here}src/index.ts`,
      preserveEntrySignatures: 'strict',
      output: {
        format: 'es',
        codeSplitting: false,
        entryFileNames: `${ENTRY}.js`,
        assetFileNames: (asset) => (asset.names.some((name) => name.endsWith('.css')) ? `${ENTRY}.css` : 'assets/[name]-[hash][extname]'),
      },
    },
  },
});
