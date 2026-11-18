import { useSyncExternalStore } from 'react';
import type YProvider from 'y-partyserver/provider';
import { removeAwarenessStates } from 'y-protocols/awareness';
import { NAME_MAX_CHARS } from '@moss-multi/protocol/limits';
import { auth } from '../auth.ts';
import { claimColor, colorOf, seedColor, type Claim } from './presence-colors.ts';
import { sessionLabels, visitMemory } from './presence-names.ts';

export interface PresenceUser {
  principalId: string; name: string; color: string; colorSettled: boolean; isAgent: boolean; slot: number;
}
/** `label` is the name this tab shows for the session: its full name, told apart from a same-named one (T9.32). */
export interface Peer extends PresenceUser { clientId: number; label: string }
export interface LocalIdentity { name: string; color: string; awarenessData: { user?: PresenceUser } }
export function localIdentity(): LocalIdentity {
  const state = auth.get();
  if (state.status !== 'signed-in') return { name: '', color: '', awarenessData: {} };
  const name = state.user.name.slice(0, NAME_MAX_CHARS);
  const slot = seedColor(state.user.id);
  return { name, color: colorOf(slot), awarenessData: { user: { principalId: state.user.id, name, slot, color: colorOf(slot), colorSettled: false, isAgent: false } } };
}
const rosters = new Map<string, Peer[]>();
const listeners = new Set<() => void>();
const empty: Peer[] = [];
function publish(docId: string, peers: Peer[]) {
  rosters.set(docId, peers);
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function usePeers(docId: string): Peer[] {
  return useSyncExternalStore(subscribe, () => rosters.get(docId) ?? empty);
}
/** The note's other sessions as last published; the remote carets read their labels here. */
export const peersOf = (docId: string): Peer[] => rosters.get(docId) ?? empty;
const names = visitMemory();

// T9.32: the session someone is inspecting in the roster (its caret is highlighted and named), and the typing
// sessions whose names found no gutter beside the text (the People here region names them instead).
const inspected = new Map<string, number>();
const noIds: number[] = [];
const unplaced = new Map<string, number[]>();
export const inspectedOf = (docId: string): number | null => inspected.get(docId) ?? null;
export function inspect(docId: string, clientId: number | null): void {
  if (inspectedOf(docId) === clientId) return;
  if (clientId === null) inspected.delete(docId); else inspected.set(docId, clientId);
  for (const listener of listeners) listener();
}
export function setUnplacedTyping(docId: string, clientIds: number[]): void {
  const now = unplaced.get(docId) ?? noIds;
  if (now.length === clientIds.length && now.every((id, i) => id === clientIds[i])) return;
  if (clientIds.length) unplaced.set(docId, clientIds); else unplaced.delete(docId);
  for (const listener of listeners) listener();
}
export function useUnplacedTyping(docId: string): number[] {
  return useSyncExternalStore(subscribe, () => unplaced.get(docId) ?? noIds);
}
export function startPresence(docId: string, provider: YProvider): () => void {
  const awareness = provider.awareness;
  const key = `moss:presence:${docId}`;
  const originalSet = awareness.setLocalState.bind(awareness);
  awareness.setLocalState = value => {
    if (value === null) { originalSet(null); return; }
    const user = value.user ?? awareness.getLocalState()?.user ?? value.awarenessData?.user;
    originalSet(user ? { ...value, user, name: user.name, color: user.color } : value);
  };
  let settling: ReturnType<typeof setTimeout> | undefined;
  let changing = false;
  let ended = false;
  let remembered: number | null = null;
  try { const value = sessionStorage.getItem(key); if (value !== null) remembered = Number(value); } catch { /* storage unavailable */ }
  const update = () => {
    if (changing || ended) return;
    changing = true;
    if (!provider.synced) { clearTimeout(settling); settling = undefined; }
    const peers: Peer[] = [];
    const claims: Claim[] = [];
    const sessions: { clientId: number; principalId: string; name: string }[] = [];
    for (const [clientId, state] of awareness.getStates()) {
      const user = state.user as PresenceUser | undefined;
      if (!user || !user.principalId) continue;
      claims.push({ id: String(clientId), slot: user.slot, settled: user.colorSettled });
      sessions.push({ clientId, principalId: user.principalId, name: user.name });
      if (clientId !== awareness.clientID) peers.push({ ...user, clientId, label: user.name });
    }
    // This tab's own session first, so its other windows are numbered after it.
    sessions.sort((a, b) => Number(b.clientId === awareness.clientID) - Number(a.clientId === awareness.clientID));
    const labels = sessionLabels(sessions, names);
    for (const peer of peers) peer.label = labels.get(peer.clientId) ?? peer.name;
    const state = awareness.getLocalState();
    const user = state?.user as PresenceUser | undefined;
    if (state && user && !document.hidden) {
      const preferred = remembered !== null && Number.isInteger(remembered) && remembered >= 0 && remembered < 10 ? remembered : user.slot;
      remembered = null;
      const slot = claimColor({ id: String(awareness.clientID), slot: preferred, settled: user.colorSettled }, claims);
      if (slot !== user.slot || state.color !== colorOf(slot)) {
        clearTimeout(settling); settling = undefined;
        awareness.setLocalState({ ...state, color: colorOf(slot), user: { ...user, slot, color: colorOf(slot), colorSettled: false } });
      }
      const current = awareness.getLocalState()!;
      if (provider.synced && !current.user.colorSettled && !settling) settling = setTimeout(() => {
        settling = undefined;
        const now = awareness.getLocalState();
        if (now && provider.synced && !document.hidden) awareness.setLocalState({ ...now, user: { ...now.user, colorSettled: true } });
      }, 500);
      try { sessionStorage.setItem(key, String(slot)); } catch { /* storage unavailable */ }
    }
    // By the name shown, so the list reads alphabetically and a newcomer never reorders the rest (T9.32).
    peers.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }) || a.clientId - b.clientId);
    publish(docId, peers);
    changing = false;
  };
  const sweep = setInterval(() => {
    const stale = [...awareness.getStates().keys()].filter(id => id !== awareness.clientID && Date.now() - (awareness.meta.get(id)?.lastUpdated ?? 0) > 12_000);
    if (stale.length) removeAwarenessStates(awareness, stale, provider);
  }, 2000);
  awareness.on('update', update);
  // The server sends its roster before first sync completes; only then start the provisional claim window.
  provider.on('sync', update);
  document.addEventListener('visibilitychange', update);
  update();
  return () => {
    ended = true; awareness.setLocalState = originalSet; clearInterval(sweep); clearTimeout(settling);
    awareness.off('update', update); document.removeEventListener('visibilitychange', update);
    provider.off('sync', update);
    publish(docId, []);
    setUnplacedTyping(docId, []);
    inspect(docId, null);
  };
}
