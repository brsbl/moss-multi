// The names the roster and the remote carets show (T9.32). Every session keeps its own row: one person in several
// windows gets a window suffix, and different people who share a full name get an ordinal. Both numbers are the order
// this tab first saw them in, kept for the visit, so they never shift as others come and go. No id is ever shown.

export interface Session { clientId: number; principalId: string; name: string }
/** First-seen order for this visit: principals per full name, client ids per principal. */
export interface NameMemory { names: Map<string, string[]>; windows: Map<string, number[]> }
export const visitMemory = (): NameMemory => ({ names: new Map(), windows: new Map() });

const ordinal = <T>(map: Map<string, T[]>, key: string, value: T): number => {
  const seen = map.get(key) ?? [];
  if (!seen.includes(value)) seen.push(value);
  map.set(key, seen);
  return seen.indexOf(value) + 1;
};

/** A label per session: `Name`, `Name (2)` for a second person of that name, `Name · window 2` for a second window. */
export function sessionLabels(sessions: Session[], memory: NameMemory): Map<number, string> {
  const people = new Map<string, Set<string>>();
  const windows = new Map<string, number>();
  for (const { principalId, name, clientId } of sessions) {
    people.set(name, (people.get(name) ?? new Set()).add(principalId));
    windows.set(principalId, (windows.get(principalId) ?? 0) + 1);
    ordinal(memory.names, name, principalId);
    ordinal(memory.windows, principalId, clientId);
  }
  const labels = new Map<number, string>();
  for (const { principalId, name, clientId } of sessions) {
    let label = name;
    if (people.get(name)!.size > 1) label += ` (${ordinal(memory.names, name, principalId)})`;
    if (windows.get(principalId)! > 1) label += ` · window ${ordinal(memory.windows, principalId, clientId)}`;
    labels.set(clientId, label);
  }
  return labels;
}
