// ported-from: packages/desktop/src/renderer/hooks/useAgentStream.ts @ 762abb777
/**
 * Hook for subscribing to agent streaming events via IPC.
 * All events are routed through updateAgentStreamAtom which updates
 * the note-specific atom (noteActionTabsAtom) directly.
 */

import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { updateAgentStreamAtom, type AgentStreamEvent } from '@moss/shared';
import { agentApi } from '../api/electron';

/**
 * Subscribes to agent stream events and routes them to the appropriate
 * note-specific atom via updateAgentStreamAtom.
 *
 * With the atomFamily pattern, all events are handled uniformly regardless
 * of which note is currently active - each note has its own isolated atom.
 */
export function useAgentStream(): void {
  const updateStream = useSetAtom(updateAgentStreamAtom);

  useEffect(() => {
    const hasElectronBridge =
      typeof window !== 'undefined' &&
      Boolean((window as typeof window & { electronAPI?: unknown }).electronAPI?.agent);

    if (!hasElectronBridge) {
      return;
    }

    return agentApi.onStream((event: AgentStreamEvent) => {
      // All events go through updateAgentStreamAtom which updates
      // the note-specific atom (noteActionTabsAtom(noteId))
      updateStream(event);
    });
  }, [updateStream]);
}
