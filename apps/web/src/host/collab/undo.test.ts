import { expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Binding } from '@lexical/yjs';
import { createBindingUndoManager, REGISTER_LOCAL_ORIGIN } from './undo.ts';
import { DERIVED_ORIGIN, isOwnOrigin, syncUnderOrigin } from './origins.ts';

it('tracks body and register edits, excluding peer, null, server and derived origins', () => {
  const doc = new Y.Doc();
  const root = doc.get('root', Y.XmlText);
  const binding = { doc, root: { getSharedType: () => root } } as unknown as Binding;
  const undo = createBindingUndoManager(binding);
  try {
    doc.transact(() => root.insert(0, 'local'), binding);
    undo.stopCapturing();
    for (const origin of [null, 'peer', 'server-seed', DERIVED_ORIGIN]) doc.transact(() => root.insert(root.length, ' kept'), origin);
    expect(undo.undoStack).toHaveLength(1);
    undo.undo(); expect(root.toString()).toBe(' kept kept kept kept');
    doc.transact(() => doc.getMap('registers').set('code', 'mine'), REGISTER_LOCAL_ORIGIN);
    undo.undo(); expect(doc.getMap('registers').has('code')).toBe(false);
    expect(root.toString()).toBe(' kept kept kept kept');
  } finally { undo.destroy(); doc.destroy(); }
});

it('the outer derived origin wins over the binding transaction and is skipped on fold-back', () => {
  const doc = new Y.Doc();
  const binding = { doc } as Binding;
  let origin: unknown;
  doc.on('update', (_update, value) => { origin = value; });
  try {
    syncUnderOrigin(binding, new Set(['formula-workspace-refresh']), () => doc.transact(() => doc.getText('x').insert(0, 'derived'), binding));
    expect(origin).toBe(DERIVED_ORIGIN);
    expect(isOwnOrigin(origin, binding)).toBe(true);
    expect(isOwnOrigin('peer', binding)).toBe(false);
  } finally { doc.destroy(); }
});
