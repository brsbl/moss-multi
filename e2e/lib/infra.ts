// Infrastructure is never a product verdict (S-test §2.8): fixtures throw InfraBlocked, the reporter writes
// test-results/blocked.json, and the summary says BLOCKED instead of FAILED.

export class InfraBlocked extends Error {
  constructor(reason: string) {
    super(`InfraBlocked: ${reason}`);
    this.name = 'InfraBlocked';
  }
}

export const isInfraBlocked = (message: string | undefined): boolean => /\bInfraBlocked: /.test(message ?? '');

const SIGNATURES: [RegExp, string][] = [
  [/<!--\[if lt IE 7\]>[\s\S]*\bie6 oldie\b/i, 'a Cloudflare error page'],
  [/\bD1(?:_ERROR)?\b[^\n]*\b7429\b/i, 'D1 7429 (overloaded)'],
  [/\berror code: 1101\b|\bWorker threw exception\b/i, 'Worker 1101'],
  [/\bECONNREFUSED\b|\bECONNRESET\b|socket hang up/i, 'the stack is unreachable'],
  [/\bEADDRINUSE\b/, 'a port in use'],
  [/Executable doesn't exist|browserType\.launch: |Failed to launch/i, 'the browser failed to launch'],
  [/\*\*\* Received signal|workerd[^\n]*(?:segmentation fault|SIGSEGV|SIGABRT)/i, 'a workerd crash'],
];

/** The infrastructure signature in a response body, log or error text, or null for a product outcome. */
export function classifyInfra(text: string): string | null {
  return SIGNATURES.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

/** Throws InfraBlocked when `text` carries an infrastructure signature. */
export function assertNotInfra(text: string, where: string): void {
  const signature = classifyInfra(text);
  if (signature) throw new InfraBlocked(`${where}: ${signature}`);
}
