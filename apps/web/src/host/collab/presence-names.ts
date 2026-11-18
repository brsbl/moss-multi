export interface Session { clientId: number; principalId: string; name: string }
export interface NameMemory { names: Map<string, string[]>; windows: Map<string, number[]> }
export const visitMemory = (): NameMemory => ({ names: new Map(), windows: new Map() });
export function sessionLabels(sessions: Session[], memory: NameMemory): Map<number, string> {
  void memory;
  return new Map(sessions.map((session) => [session.clientId, session.name]));
}
