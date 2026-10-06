// Inside the composer: per mount, routed deletes (Suggest), insert and strike paint (Suggest and Review), Edit-mode
// marks over the body, dropping undo steps of a closed record, and the caret put back after a mode switch
// (docs/design/suggestions.md §5, §7).
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import type { EditMode } from '@moss-multi/protocol/dom-contract';
import { payloadDocsFor } from '@moss-multi/sync/payload-docs';
import { Composite, destroyView, openRecords, type Built } from '@moss-multi/sync/suggest/client';
import { useEffect, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import { bindingOf } from '../binding-registry.ts';
import { restoreCaret, type CaretMark } from './caret.ts';
import { rangesWhere } from './chars.ts';
import { ReviewMount, SuggestMount } from './mounts.ts';
import { clearPaint, drawMarks, editMarks, paintBound, paintRanges, partTargets, struckByRecord } from './paint.ts';
import { registerSuggestRouting } from './routing.ts';
import { openSuggestion } from './SuggestionsPanel.tsx';

export interface SuggestPane {
  readonly docId: string;
  readonly mode: EditMode;
  readonly mount: SuggestMount | ReviewMount | null;
  /** B, the session's doc, while one is attached. */
  readonly body: Y.Doc | null;
  /** The body is bound and showing (live or read-only). */
  readonly bodyOpen: boolean;
  takeCaret(): CaretMark | null;
  keepCaret(mark: CaretMark): void;
  subscribeMount(listener: () => void): () => void;
}

const covers = (spans: readonly { client: number; clock: number; len: number }[], id: Y.ID) =>
  spans.some((span) => span.client === id.client && span.clock <= id.clock && id.clock < span.clock + span.len);

/** A pointer-transparent layer over the editor for Edit-mode marks. */
function overlayFor(root: HTMLElement | null): HTMLElement | null {
  const host = root?.parentElement;
  if (!host) return null;
  let overlay = host.querySelector<HTMLElement>(':scope > [data-suggest-overlay]');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.dataset.suggestOverlay = '';
    overlay.className = 'moss-suggest-overlay';
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(overlay);
  }
  return overlay;
}

export function SuggestPlugin({ pane }: { pane: SuggestPane }): null {
  const [editor] = useLexicalComposerContext();
  const mount = useSyncExternalStore(pane.subscribeMount, () => pane.mount);
  const body = useSyncExternalStore(pane.subscribeMount, () => pane.body);
  const mode = pane.mode;

  useEffect(() => {
    const owner = {};
    const stops: (() => void)[] = [];
    let frame = 0;
    let built: Built | null = null;
    // Edit mode: each valid record's struck body items, rebuilt with C.
    let struckBy = new Map<string, { client: number; clock: number; len: number }[]>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const overlay = mode === 'edit' ? overlayFor(editor.getRootElement()) : null;

    const paint = () => {
      frame = 0;
      const binding = bindingOf(editor);
      if (!binding) return;
      // The caret goes back once this mount is open for typing; a read-only Review keeps it for the next mode.
      if (pane.bodyOpen && editor.isEditable()) {
        const caret = pane.takeCaret();
        if (caret && !restoreCaret(editor, caret)) pane.keepCaret(caret);
      }
      if (mount instanceof SuggestMount) {
        paintBound(owner, editor, binding, mount.fork.ownClients(), mount.fork.struck(), body);
      } else if (mount instanceof ReviewMount) {
        paintBound(owner, editor, binding, new Set(mount.clients.keys()), body ? partTargets(body, new Set(mount.valid)) : [], body);
      } else if (built && body) {
        // Strikes: delete-part targets, and body items a record's own ops remove (a join, a split, a restyle).
        const struck = [...struckBy.values()].flat();
        paintRanges(owner, [], struck.length ? rangesWhere(editor, binding, (id) => covers(struck, id)) : []);
        if (overlay) drawMarks(editor, overlay, editMarks(body, built, binding), (record) => openSuggestion(pane.docId, record));
      } else {
        clearPaint(owner);
        overlay?.replaceChildren();
      }
    };
    const repaint = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    stops.push(editor.registerUpdateListener(repaint));
    stops.push(editor.registerEditableListener(repaint));
    stops.push(pane.subscribeMount(repaint));
    window.addEventListener('resize', repaint);
    stops.push(() => window.removeEventListener('resize', repaint));

    if (mount instanceof SuggestMount) {
      mount.editor = editor;
      stops.push(registerSuggestRouting(editor, mount.fork));
    }
    // A click on a painted suggestion opens its card (§7 hit test): the record whose inserted or struck text is under
    // it. Review paints both; Edit paints strikes over the body (its inserts are wedges and gutter bars).
    const hitTargets = (): Map<string, (id: Y.ID) => boolean> => {
      const out = new Map<string, (id: Y.ID) => boolean>();
      if (mount instanceof ReviewMount) {
        const struck = body ? struckByRecord(body, new Set(mount.valid)) : new Map<string, { client: number; clock: number; len: number }[]>();
        const clientsOf = new Map<string, Set<number>>();
        for (const [client, record] of mount.clients) clientsOf.set(record, (clientsOf.get(record) ?? new Set()).add(client));
        for (const record of new Set([...clientsOf.keys(), ...struck.keys()])) {
          const clients = clientsOf.get(record) ?? new Set<number>();
          const spans = struck.get(record) ?? [];
          out.set(record, (id) => clients.has(id.client) || covers(spans, id));
        }
      } else if (mode === 'edit' && !(mount instanceof SuggestMount)) {
        for (const [record, spans] of struckBy) out.set(record, (id) => covers(spans, id));
      }
      return out;
    };
    if (mount instanceof ReviewMount || (mode === 'edit' && !(mount instanceof SuggestMount))) {
      const root = editor.getRootElement();
      const onClick = (event: MouseEvent) => {
        const binding = bindingOf(editor);
        if (!binding) return;
        const under = (range: Range) => [...range.getClientRects()].some((rect) => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom);
        for (const [record, hit] of hitTargets()) {
          if (rangesWhere(editor, binding, hit).some(under)) {
            openSuggestion(pane.docId, record);
            return;
          }
        }
      };
      root?.addEventListener('click', onClick);
      stops.push(() => root?.removeEventListener('click', onClick));
    }
    if (mode === 'edit' && body) {
      // Edit mode: C is rebuilt from B's records, throttled, only while any record is open.
      const composite = new Composite(body);
      const rebuild = () => {
        if (built) destroyView(built);
        built = openRecords(body).length ? composite.build() : null;
        struckBy = built ? struckByRecord(body, new Set(built.valid), built) : new Map();
        repaint();
      };
      // Throttled, so marks follow a peer who types without pause.
      const onUpdate = () => {
        if (timer !== undefined) return;
        timer = setTimeout(() => {
          timer = undefined;
          rebuild();
        }, 200);
      };
      body.on('update', onUpdate);
      // A record editing a payload shows once that payload has arrived.
      const stopArrivals = payloadDocsFor(body).onArrive(onUpdate);
      stops.push(() => {
        body.off('update', onUpdate);
        stopArrivals();
      });
      rebuild();
    }
    repaint();
    return () => {
      for (const stop of stops) stop();
      clearTimeout(timer);
      if (frame) cancelAnimationFrame(frame);
      if (built) destroyView(built);
      clearPaint(owner);
      overlay?.remove();
    };
  }, [body, editor, mode, mount, pane]);
  return null;
}
