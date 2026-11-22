// Same-name agents in Settings → Agents can always be told apart by their rows (T9.45).
import { describe, expect, it } from 'vitest';
import { createdLabel, type AgentRecord } from './agent-label.ts';

const agent = (id: string, name: string, iso: string): AgentRecord => ({ id, name, createdAt: Date.parse(iso) });

describe('createdLabel', () => {
  it('shows nothing for a name no other agent has', () => {
    const agents = [agent('a', 'Scribe', '2026-11-20T12:00:00Z'), agent('b', 'Courier', '2026-11-20T12:00:00Z')];
    expect(createdLabel(agents[0]!, agents)).toBeNull();
  });

  it('shows the day for same-name agents made on different days', () => {
    const agents = [agent('a', 'Scribe', '2026-11-20T12:00:00Z'), agent('b', 'scribe ', '2026-11-21T12:00:00Z')];
    const [first, second] = agents.map((one) => createdLabel(one, agents));
    expect(first).not.toBeNull();
    expect(first).not.toBe(second);
    expect(first).not.toMatch(/\d:\d\d/);
  });

  it('adds the time for same-name agents made the same day, so neither row nor its revoke reads the same', () => {
    const agents = [agent('a', 'Scribe', '2026-11-20T12:00:00Z'), agent('b', 'Scribe', '2026-11-20T12:00:07Z')];
    const [first, second] = agents.map((one) => createdLabel(one, agents));
    expect(first).toMatch(/\d:\d\d/);
    expect(first).not.toBe(second);
  });
});
