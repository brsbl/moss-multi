// ported-from: .ladle/vite.config.mjs @ 762abb777
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const workspaceRoot = path.resolve(__dirname, '..');
const sharedSrc = path.resolve(workspaceRoot, 'packages/shared/src');
const desktopRendererSrc = path.resolve(workspaceRoot, 'packages/desktop/src/renderer');

const createRendererManualChunks = (id) => {
  const normalizedId = id.split(path.sep).join('/');
  if (!normalizedId.includes('/node_modules/')) {
    if (normalizedId.includes('/packages/shared/src/state/')) {
      return 'app-state';
    }
    if (normalizedId.includes('/packages/shared/src/components/')) {
      return 'app-shared-components';
    }
    if (normalizedId.includes('/packages/desktop/src/renderer/panels/')) {
      return 'app-panels';
    }
    if (normalizedId.includes('/packages/desktop/src/renderer/components/')) {
      return 'app-components';
    }
    if (normalizedId.includes('/packages/desktop/src/renderer/editor/') && !normalizedId.endsWith('/ChartRenderer.tsx')) {
      return 'app-editor';
    }
    return undefined;
  }
  if (
    normalizedId.includes('/recharts/') ||
    normalizedId.includes('/d3-') ||
    normalizedId.includes('/victory-vendor/')
  ) {
    return 'vendor-charts';
  }
  if (normalizedId.includes('/@lexical/') || normalizedId.includes('/lexical/')) {
    return 'vendor-lexical';
  }
  if (
    normalizedId.includes('/react-dom/') ||
    normalizedId.includes('/react/') ||
    normalizedId.includes('/scheduler/')
  ) {
    return 'vendor-react';
  }
  if (normalizedId.includes('/@radix-ui/')) {
    return 'vendor-radix';
  }
  if (normalizedId.includes('/jotai/') || normalizedId.includes('/jotai-family/')) {
    return 'vendor-state';
  }
  if (normalizedId.includes('/prismjs/')) {
    return 'vendor-code';
  }
  return undefined;
};

export default defineConfig(async () => {
  const { default: sharedTailwindConfig } = await import('../packages/shared/tailwind.config.ts');

  return {
    build: {
      rollupOptions: {
        output: {
          manualChunks: createRendererManualChunks
        }
      }
    },
    resolve: {
      alias: [
        { find: /^@\/(.*)/, replacement: `${sharedSrc}/$1` },
        { find: '@', replacement: desktopRendererSrc },
        { find: '@moss/shared', replacement: sharedSrc }
      ]
    },
    css: {
      postcss: {
        plugins: [
          tailwindcss({
            ...sharedTailwindConfig,
            content: [
              path.resolve(workspaceRoot, 'packages/desktop/stories/**/*.{ts,tsx,mdx}'),
              path.resolve(workspaceRoot, 'packages/desktop/src/renderer/**/*.{ts,tsx,html}'),
              path.resolve(workspaceRoot, 'packages/shared/src/**/*.{ts,tsx,mdx}')
            ]
          }),
          autoprefixer()
        ]
      }
    }
  };
});
