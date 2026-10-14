// Substituted for apps/web's hide registry (host/affordances.ts) in the editor bundle. The editor saves moss's
// comments as desktop does (markers plus comments.json), so its comment UI is live; every other withheld affordance
// needs the Mac app (Finder, agents, the system emoji panel, workspace settings) and stays hidden in a plugin frame.
const SHOWN = new Set(['comments']);

export function hidden(id: string): boolean {
  return !SHOWN.has(id);
}
