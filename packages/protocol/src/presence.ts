// Presence colors and the agent-push window (A§10.7), shared by the web client and the DocDO's agent entry.

/** The 10-slot palette, as moss DS tokens. */
export const PALETTE = ['chart-blue', 'chart-terra', 'chart-sage', 'chart-lavender', 'chart-wheat', 'sketch-plum', 'sketch-teal', 'sketch-coral', 'sketch-rose', 'sketch-charcoal'];
export const colorOf = (slot: number): string => `var(--${PALETTE[slot % PALETTE.length]})`;
/** An FNV hash of the principal id seeds a client's color slot. */
export function seedColor(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return (hash >>> 0) % PALETTE.length;
}

/** How long an agent's push shows it in the face pile (PRODUCT: Bot-badged presence; A§10.7 "15 s"). */
export const AGENT_PRESENCE_MS = 15_000;
/** Re-sent this often while shown: a client drops a peer state it has not heard for 12 s. */
export const AGENT_PRESENCE_REFRESH_MS = 8_000;
