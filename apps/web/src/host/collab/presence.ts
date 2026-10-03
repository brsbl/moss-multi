import { useSyncExternalStore } from 'react';
import type YProvider from 'y-partyserver/provider';
import { removeAwarenessStates } from 'y-protocols/awareness';
import { NAME_MAX_CHARS } from '@moss-multi/protocol/limits';
import { auth } from '../auth.ts';
import { claimColor, colorOf, seedColor, type Claim } from './presence-colors.ts';

export interface PresenceUser {
  principalId: string; name: string; color: string; colorSettled: boolean; isAgent: boolean; slot: number;
}
export interface Peer extends PresenceUser { clientId: number }
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
export function usePeers(docId: string): Peer[] {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => rosters.get(docId) ?? empty);
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
    const peers: Peer[] = [];
    const claims: Claim[] = [];
    for (const [clientId, state] of awareness.getStates()) {
      const user = state.user as PresenceUser | undefined;
      if (!user || !user.principalId) continue;
      claims.push({ id: String(clientId), slot: user.slot, settled: user.colorSettled });
      if (clientId !== awareness.clientID) peers.push({ ...user, clientId });
    }
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
      if (!current.user.colorSettled && !settling) settling = setTimeout(() => {
        settling = undefined;
        const now = awareness.getLocalState();
        if (now && !document.hidden) awareness.setLocalState({ ...now, user: { ...now.user, colorSettled: true } });
      }, 500);
      try { sessionStorage.setItem(key, String(slot)); } catch { /* storage unavailable */ }
    }
    peers.sort((a, b) => a.principalId < b.principalId ? -1 : a.principalId > b.principalId ? 1 : a.clientId - b.clientId);
    publish(docId, peers);
    changing = false;
  };
  const sweep = setInterval(() => {
    const stale = [...awareness.getStates().keys()].filter(id => id !== awareness.clientID && Date.now() - (awareness.meta.get(id)?.lastUpdated ?? 0) > 12_000);
    if (stale.length) removeAwarenessStates(awareness, stale, provider);
  }, 2000);
  awareness.on('update', update);
  document.addEventListener('visibilitychange', update);
  update();
  return () => {
    ended = true; awareness.setLocalState = originalSet; clearInterval(sweep); clearTimeout(settling);
    awareness.off('update', update); document.removeEventListener('visibilitychange', update);
    publish(docId, []);
  };
}
