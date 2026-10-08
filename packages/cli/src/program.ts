// The moss-multi command surface (A§17): not built yet (T7.1 tests first).
import { TRASH_COPY } from '@moss-multi/protocol/retention';

export interface ProgramDeps {
  env?: Record<string, string | undefined>;
  cwd?: () => string;
  fetchImpl?: typeof fetch;
  stdout?: (chunk: Uint8Array | string) => void;
  stderr?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  openUrl?: (url: string) => void;
}

export async function runCli(args: string[], deps: ProgramDeps = {}): Promise<number> {
  (deps.stderr ?? ((line) => process.stderr.write(`${line}\n`)))(`moss-multi: ${args[0] ?? ''} is not built yet (${TRASH_COPY.cliTrashed.length})`);
  return 1;
}
