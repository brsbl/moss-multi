// The editor bundle: one ESM entry, one stylesheet and moss's font files in dist/, the host helpers
// (moss-editor-host.js, byte for byte), the moss-html frame document, and editor.json recording the moss pin, the
// source commit, the CI run, the CSP the frame needs and the hash of every file. Moss's aliases match apps/web's
// (A§2); a few leaf modules are substituted by absolute path (A§2.1), so the vendored files stay byte-identical.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import viteReact from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { readSource } from '../../apps/web/vite-provenance.ts';
import { HTML_FRAME_ISOLATED_DOCUMENT } from '../protocol/src/html-frame.ts';
import { MOSS_EDITOR_API, MOSS_EDITOR_INFO } from './src/host/moss-editor-host.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const vendor = `${repoRoot}vendor/moss/packages`;
const editorUtils = `${vendor}/desktop/src/renderer/editor/utils`;
const pkg = JSON.parse(readFileSync(`${here}package.json`, 'utf8')) as { name: string; version: string };

const ENTRY = 'moss-editor';
const HOST_ENTRY = 'moss-editor-host.js';
const FRAME = 'moss-html-frame.html';
const API = MOSS_EDITOR_API;
if (MOSS_EDITOR_INFO.version !== pkg.version) throw new Error(`MOSS_EDITOR_INFO.version ${MOSS_EDITOR_INFO.version} != package ${pkg.version}`);
/**
 * What a host serves moss-html-frame.html with (API 2, contract.ts MossEditorManifest.htmlFrame): an opaque-origin
 * sandbox that runs the block's inline scripts and styles and shows data: and blob: images, and refuses every request
 * and frame load. The document itself (HTML_FRAME_ISOLATED_DOCUMENT) puts the block's navigations under that policy,
 * and its in-realm guard removes WebRTC as defense in depth only.
 */
const FRAME_POLICY =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
const editorNodes = `${vendor}/desktop/src/renderer/editor/nodes`;
const SUBSTITUTES: Record<string, string> = {
  [`${editorNodes}/node-views.ts`]: `${here}src/substitutes/node-views.ts`,
  [`${editorNodes}/register-views.tsx`]: `${here}src/substitutes/register-views.tsx`,
  [`${editorUtils}/asset-url.ts`]: `${here}src/substitutes/asset-url.ts`,
  [`${editorUtils}/media-server-url.ts`]: `${here}src/substitutes/media-server-url.ts`,
  [`${repoRoot}apps/web/src/host/affordances.ts`]: `${here}src/substitutes/affordances.ts`,
  [`${repoRoot}apps/web/src/host/access.ts`]: `${here}src/substitutes/access.ts`,
  [`${repoRoot}apps/web/src/host/media/web-asset-url.ts`]: `${here}src/substitutes/web-asset-url.ts`,
};

/** The frame's CSP requirements (docs/design/editor-embed.md §9); CI's e2e runs the editor under exactly this. */
const CSP: Record<string, string[]> = {
  'default-src': ["'none'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'font-src': ["'self'"],
  'img-src': ["'self'", 'data:', 'blob:', 'https:', '<asset-origin>'],
  // data: is the empty URL an unresolved video reference gets (registry.ts NO_MEDIA), so it shows moss's missing state.
  'media-src': ["'self'", 'data:', 'blob:', '<asset-origin>'],
  'frame-src': ['data:', 'https:', '<html-frame-origin>'],
  'connect-src': ["'none'"],
  'worker-src': ["'none'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
};

function substitutes(): Plugin {
  return {
    name: 'moss-editor-substitutes',
    enforce: 'pre',
    load(id) {
      const file = SUBSTITUTES[id];
      return file ? readFileSync(file, 'utf8') : null;
    },
  };
}

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

function extraFiles(): Plugin {
  return {
    name: 'moss-editor-files',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: FRAME, source: HTML_FRAME_ISOLATED_DOCUMENT });
      this.emitFile({ type: 'asset', fileName: HOST_ENTRY, source: readFileSync(`${here}src/host/${HOST_ENTRY}`) });
    },
  };
}

/**
 * The entry's split (T3.12): libraries every note needs go into their own content-hashed chunks, which a host caches
 * immutably across editor releases that leave them unchanged, so the unhashed entry a host revalidates stays small.
 * A library only a lazy family uses (recharts, parse5) stays in that family's chunk.
 */
const VENDOR_CHUNKS: { name: string; test: RegExp }[] = [
  { name: 'react', test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/ },
  { name: 'lexical', test: /[\\/]node_modules[\\/](?:lexical|@lexical[\\/][^\\/]+)[\\/]/ },
  { name: 'base-ui', test: /[\\/]node_modules[\\/]@(?:base-ui|floating-ui)[\\/]/ },
];

/** editor.json (contract.ts MossEditorManifest): what was built, from which sources, and every emitted file's hash. */
function manifest(): Plugin {
  return {
    name: 'moss-editor-manifest',
    apply: 'build',
    writeBundle(options, bundle) {
      const outputs = Object.values(bundle)
        .map((output) => {
          const content = output.type === 'chunk' ? output.code : output.source;
          return { fileName: output.fileName, bytes: Buffer.from(content) };
        })
        .sort((a, b) => (a.fileName < b.fileName ? -1 : 1));
      const digest = createHash('sha256');
      for (const { fileName, bytes } of outputs) digest.update(`${fileName}\0${bytes.length}\0`).update(bytes);
      const ported = JSON.parse(readFileSync(`${repoRoot}vendor/moss/PORTED.json`, 'utf8')) as { upstream: string; pin: string; commit: string };
      const source = readSource(repoRoot);
      // Every script chunk besides the entry, and the ones the entry imports statically (a host may preload them).
      const chunks = Object.values(bundle).filter((output) => output.type === 'chunk');
      const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
      const preload = new Set<string>();
      const visit = (fileName: string) => {
        for (const next of byName.get(fileName)?.imports ?? []) {
          if (preload.has(next)) continue;
          preload.add(next);
          visit(next);
        }
      };
      visit(`${ENTRY}.js`);
      const record = {
        name: pkg.name,
        version: pkg.version,
        api: API,
        features: [...MOSS_EDITOR_INFO.features] as string[],
        entry: `${ENTRY}.js`,
        css: `${ENTRY}.css`,
        hostEntry: HOST_ENTRY,
        chunks: chunks.map((chunk) => chunk.fileName).filter((fileName) => fileName !== `${ENTRY}.js`).sort(),
        preload: [...preload].sort(),
        htmlFrame: { file: FRAME, policy: FRAME_POLICY },
        moss: { upstream: ported.upstream, pin: ported.pin, commit: ported.commit },
        source: { repo: 'brsbl/moss-multi', commit: source.commit, headSha: source.headSha, dirty: source.dirty, diffHash: source.diffHash },
        build: { run: process.env.GITHUB_RUN_ID ? `https://github.com/brsbl/moss-multi/actions/runs/${process.env.GITHUB_RUN_ID}` : null },
        bundleHash: digest.digest('hex'),
        files: Object.fromEntries(outputs.map(({ fileName, bytes }) => [fileName, { bytes: bytes.length, sha256: sha256(bytes) }])),
        editableScopes: ['internal'],
        csp: CSP,
      };
      writeFileSync(`${options.dir}/editor.json`, `${JSON.stringify(record, null, 2)}\n`);
    },
  };
}

export default defineConfig({
  plugins: [substitutes(), viteReact(), extraFiles(), manifest()],
  base: './',
  resolve: {
    alias: [
      { find: /^@moss\/shared$/, replacement: `${vendor}/shared/src/index.ts` },
      { find: /^@moss\/shared\/(.*)$/, replacement: `${vendor}/shared/src/$1` },
      { find: /^@\/(.*)$/, replacement: `${vendor}/shared/src/$1` },
      { find: /^@moss-desktop\/(.*)$/, replacement: `${vendor}/desktop/src/$1` },
      { find: /^@moss-multi\/host\/(.*)$/, replacement: `${repoRoot}apps/web/src/host/$1` },
      { find: /^@moss-editor\/(.*)$/, replacement: `${here}src/$1.ts` },
      { find: /^@moss-pristine\/(.*)$/, replacement: `${editorUtils}/$1.ts?pristine` },
      { find: /^@moss-web-pristine\/(.*)$/, replacement: `${repoRoot}apps/web/src/host/$1.ts?pristine` },
    ],
    dedupe: ['react', 'react-dom', 'jotai', 'jotai-family', 'lexical', 'yjs', 'prismjs'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
    rolldownOptions: {
      input: `${here}src/index.ts`,
      preserveEntrySignatures: 'strict',
      output: {
        format: 'es',
        codeSplitting: { groups: VENDOR_CHUNKS },
        entryFileNames: `${ENTRY}.js`,
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (asset) => (asset.names.some((name) => name.endsWith('.css')) ? `${ENTRY}.css` : 'assets/[name]-[hash][extname]'),
      },
    },
  },
});
