// ported-from: packages/desktop/src/renderer/utils/renderer-env.ts @ 762abb777
type RendererProcessGlobal = typeof globalThis & {
  process?: {
    env?: Record<string, string | undefined>;
  };
};

export function getRendererEnv(name: string): string | undefined {
  const processEnv = (globalThis as RendererProcessGlobal).process?.env;
  if (processEnv?.[name] !== undefined) {
    return processEnv[name];
  }
  return undefined;
}

export function isRendererDevelopment(): boolean {
  return getRendererEnv('NODE_ENV') === 'development';
}

export function isRendererProduction(): boolean {
  return !isRendererDevelopment();
}

export function isQuitProfilingEnabled(): boolean {
  return getRendererEnv('MOSS_PROFILE_QUIT') === '1';
}
