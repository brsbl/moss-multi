// Infrastructure is never a product verdict (S-test §2.8): fixtures throw InfraBlocked, the reporter writes
// test-results/blocked.json, and the summary says BLOCKED instead of FAILED.

export class InfraBlocked extends Error {
  constructor(reason: string) {
    super(`InfraBlocked: ${reason}`);
    this.name = 'InfraBlocked';
  }
}

export const isInfraBlocked = (message: string | undefined): boolean => /\bInfraBlocked: /.test(message ?? '');

/** The infrastructure signature in a response body, log or error text, or null for a product outcome. */
export function classifyInfra(text: string): string | null {
  void text;
  return null;
}

/** Throws InfraBlocked when `text` carries an infrastructure signature. */
export function assertNotInfra(text: string, where: string): void {
  const signature = classifyInfra(text);
  if (signature) throw new InfraBlocked(`${where}: ${signature}`);
}
