// ported-from: .ladle/config.mjs @ 762abb777
import { fileURLToPath } from 'node:url';

/** @type {import('@ladle/react').Config} */
const config = {
  stories: 'packages/desktop/stories/**/*.stories.@(js|jsx|ts|tsx)',
  viteConfig: fileURLToPath(new URL('./vite.config.mjs', import.meta.url)),
  // Disable Ladle's width addon completely - stories should be full viewport width
  addons: {
    width: {
      enabled: false,
      options: {},
      defaultState: 0
    }
  }
};

export default config;
