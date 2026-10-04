import { expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Binding } from '@lexical/yjs';
import { payloadDocsFor, payloadText } from '@moss-multi/sync/payload-docs';
import { createBindingUndoManager, REGISTER_LOCAL_ORIGIN } from './undo.ts';
import { DERIVED_ORIGIN, isOwnOrigin, syncUnderOrigin } from './origins.ts';

it('one stack over body and payload edits, in order, excluding peer, null, server and derived origins', () => {
  const doc = new Y.Doc();
  const root = doc.get('root', Y.XmlText);
  const binding = { doc, root: { getSharedType: () => root } } as unknown as Binding;
  const payloads = payloadDocsFor(doc);
  const code = payloads.hold('code');
  const undo = createBindingUndoManager(binding);
  try {
    doc.transact(() => root.insert(0, 'local'), binding);
    for (const origin of [null, 'peer', 'server-seed', DERIVED_ORIGIN]) doc.transact(() => root.insert(root.length, ' kept'), origin);
    code.transact(() => payloadText(code).insert(0, 'mine'), REGISTER_LOCAL_ORIGIN);
    code.transact(() => payloadText(code).insert(4, ' peer'), 'peer');
    undo.undo();
    expect(payloadText(code).toString(), 'the latest step is the payload edit').toBe(' peer');
    expect(root.toString()).toBe('local kept kept kept kept');
    undo.undo();
    expect(root.toString()).toBe(' kept kept kept kept');
    undo.redo();
    expect(root.toString()).toBe('local kept kept kept kept');
    expect(payloadText(code).toString(), 'redo replays one step at a time').toBe(' peer');
    // A payload held after the stack was made (a block created or received later) joins it.
    const later = payloads.hold('later');
    later.transact(() => payloadText(later).insert(0, 'new'), REGISTER_LOCAL_ORIGIN);
    undo.undo();
    expect(payloadText(later).toString()).toBe('');
    expect(root.toString()).toBe('local kept kept kept kept');
  } finally { undo.destroy(); payloads.destroy(); doc.destroy(); }
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
