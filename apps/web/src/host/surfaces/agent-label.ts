// What tells same-name agents apart in Settings → Agents (T9.45): nothing for a unique name, its creation day otherwise.
export interface AgentRecord {
  id: string;
  name: string;
  createdAt: number;
}

export const sameName = (a: string, b: string): boolean => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** The creation label a row shows beside its name, or null when no other agent shares the name. */
export function createdLabel(agent: AgentRecord, agents: readonly AgentRecord[]): string | null {
  const twins = agents.filter((other) => other.id !== agent.id && sameName(other.name, agent.name));
  if (twins.length === 0) return null;
  return new Date(agent.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
