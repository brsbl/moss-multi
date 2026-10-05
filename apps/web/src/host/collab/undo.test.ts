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
    // A pause longer than the capture window ends the step, as it would for one UndoManager.
    undo.stopCapturing();
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
    undo.stopCapturing();
    const later = payloads.hold('later');
    later.transact(() => payloadText(later).insert(0, 'new'), REGISTER_LOCAL_ORIGIN);
    undo.undo();
    expect(payloadText(later).toString()).toBe('');
    expect(root.toString()).toBe('local kept kept kept kept');
  } finally { undo.destroy(); payloads.destroy(); doc.destroy(); }
});

it('edits in the body and a payload within one capture window are one step, as under one UndoManager', () => {
  const doc = new Y.Doc();
  const root = doc.get('root', Y.XmlText);
  const binding = { doc, root: { getSharedType: () => root } } as unknown as Binding;
  const payloads = payloadDocsFor(doc);
  const code = payloads.hold('code');
  const undo = createBindingUndoManager(binding);
  try {
    doc.transact(() => root.insert(0, 'body'), binding);
    code.transact(() => payloadText(code).insert(0, 'code'), REGISTER_LOCAL_ORIGIN);
    doc.transact(() => root.insert(4, '!'), binding);
    undo.undo();
    expect([root.toString(), payloadText(code).toString()]).toEqual(['', '']);
    undo.redo();
    expect([root.toString(), payloadText(code).toString()]).toEqual(['body!', 'code']);
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

it('a step whose payload edit a peer emptied is skipped, never an older payload edit in its place', () => {
  const doc = new Y.Doc();
  const root = doc.get('root', Y.XmlText);
  const binding = { doc, root: { getSharedType: () => root } } as unknown as Binding;
  const payloads = payloadDocsFor(doc);
  const code = payloads.hold('code');
  const text = payloadText(code);
  const undo = createBindingUndoManager(binding);
  try {
    code.transact(() => text.insert(0, 'old'), REGISTER_LOCAL_ORIGIN);
    undo.stopCapturing();
    doc.transact(() => root.insert(0, 'body'), binding);
    undo.stopCapturing();
    code.transact(() => text.insert(3, 'new'), REGISTER_LOCAL_ORIGIN);
    // A peer deletes the newest local payload edit, so its step has nothing left to undo.
    code.transact(() => text.delete(3, 3), 'peer');
    undo.undo();
    expect([root.toString(), text.toString()], 'the next step down is the body edit').toEqual(['', 'old']);
    undo.undo();
    expect([root.toString(), text.toString()]).toEqual(['', '']);
    undo.redo();
    expect([root.toString(), text.toString()]).toEqual(['', 'old']);
    undo.redo();
    expect([root.toString(), text.toString()]).toEqual(['body', 'old']);
  } finally { undo.destroy(); payloads.destroy(); doc.destroy(); }
});
