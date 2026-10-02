// moss's own .ladle/vite.config.mjs, minus `manualChunks`: under Ladle's Vite 6 those chunks form a cycle and the
// built oracle throws "Cannot read properties of undefined (reading 'createContext')" before any story renders.
// Chunking only changes how bytes load, never what renders.
import mossConfig from './moss/.ladle/vite.config.mjs';

export default async (env) => {
  const config = await (typeof mossConfig === 'function' ? mossConfig(env) : mossConfig);
  delete config.build?.rollupOptions?.output?.manualChunks;
  return config;
};
