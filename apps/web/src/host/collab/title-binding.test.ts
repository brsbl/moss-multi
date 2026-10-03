// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { readField, writeField } from '@moss-multi/core/doc-fields';
import { TitleField } from './title-binding.ts';

function mount(doc: Y.Doc) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const field = new TitleField(() => {});
  field.connect({ current: el }, () => {});
  field.show('note');
  field.bind('note', doc);
  field.setOpen(true);
  return { el, field, close: () => { field.unbind(); el.remove(); doc.destroy(); } };
}

describe('title binding', () => {
  it('preserves a peer insertion while IME composition owns the DOM', () => {
    const doc = new Y.Doc();
    writeField(doc, 'title', 'Plan', 'seed');
    const { el, field, close } = mount(doc);
    try {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      el.textContent = 'Plans';
      field.write('Plans');
      doc.getText('title').insert(0, 'Peer ');
      expect(el.textContent).toBe('Plans');
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      expect(readField(doc, 'title')).toBe('Peer Plans');
      expect(el.textContent).toBe('Peer Plans');
    } finally { close(); }
  });

  it('cannot write a previous note after the pane switches identity', () => {
    const doc = new Y.Doc();
    writeField(doc, 'title', 'Original', 'seed');
    const { field, close } = mount(doc);
    try {
      field.show('another-note');
      field.write('Wrong note');
      expect(readField(doc, 'title')).toBe('Original');
      expect(field.writable).toBe(false);
    } finally { close(); }
  });

  it('renders a literal Untitled without treating it as a placeholder', () => {
    const doc = new Y.Doc();
    writeField(doc, 'title', 'Untitled', 'seed');
    const { el, close } = mount(doc);
    try { expect(el.textContent).toBe('Untitled'); } finally { close(); }
  });
});
