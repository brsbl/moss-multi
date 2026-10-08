import { EXIT } from '@moss-multi/protocol/push';

export { EXIT };

/** A failure carrying its exit code: 1 other, 2 failed hunks, 3 degenerate (A§17). */
export class CliError extends Error {
  constructor(readonly exitCode: number, message: string, readonly status?: number) {
    super(message);
    this.name = 'CliError';
  }
}

export const NOT_SIGNED_IN = 'not signed in: run `moss-multi login` or set MOSS_MULTI_API_KEY';
