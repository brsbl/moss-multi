// The gate in front of a doc or folder route (A§4.2): asks once per document load whether the caller may open it.
// Signed out with no link goes to /login?next=; a transient failure retries in place (R10); a denial renders the one
// denial page, so moss never mounts behind it.
import { useEffect, useRef, useState } from 'react';
import { ACCESS_RETRY_MS } from './access.ts';
import { setAppState } from './app-state.ts';
import { LOGIN_PATH } from './auth-state.ts';
import { leaveTo } from './navigation.ts';

export type Gate = 'asking' | 'degraded' | 'open' | 'denied';
export type GateAnswer = { kind: 'open' | 'denied' | 'signed-out' | 'unavailable' };

/** `ask` is a module function of the id, so the gate asks again only when the id changes. */
export function useAccessGate(id: string, ask: (id: string) => Promise<GateAnswer>): { gate: Gate; retry: () => void } {
  const [gate, setGate] = useState<Gate>('asking');
  const wake = useRef<() => void>(() => undefined);
  useEffect(() => {
    let stopped = false;
    void (async () => {
      for (let attempt = 0; !stopped; attempt += 1) {
        const answer = await ask(id);
        if (stopped) return;
        if (answer.kind === 'signed-out') {
          leaveTo(`${LOGIN_PATH}?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
          return;
        }
        if (answer.kind !== 'unavailable') {
          if (attempt > 0) setAppState('booting');
          setGate(answer.kind === 'open' ? 'open' : 'denied');
          return;
        }
        setGate('degraded');
        setAppState('degraded');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ACCESS_RETRY_MS[Math.min(attempt, ACCESS_RETRY_MS.length - 1)]);
          wake.current = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    })();
    return () => {
      stopped = true;
      wake.current();
    };
  }, [id, ask]);
  return { gate, retry: () => wake.current() };
}
