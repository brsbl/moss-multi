import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { exportDocMarkdown, importBody } from './server-doc.ts';

it('recomputes executable export results without changing authored symbolic values or the shared state', () => {
  const doc = new Y.Doc();
  try {
    importBody(doc, '{{2+3|99}} and {{timeline|6 weeks}}');
    const before = Y.encodeStateAsUpdate(doc);
    const markdown = exportDocMarkdown(doc);
    expect(markdown).toContain('2+3|5');
    expect(markdown).toContain('timeline|6 weeks');
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  } finally { doc.destroy(); }
});

const NOTE_ID = '1d0c7f3b-5b65-4eb7-b510-8c3b2e170caa';
const PRICE_ID = '7bea9c0f-317a-48a1-83a7-9a1e4e7b36aa';
const DOUBLE_ID = 'd787ef71-6050-45e0-8a24-dbb8190880dc';

it('recomputes same-note dependencies using the document identity without mutating live results', () => {
  const doc = new Y.Doc();
  // Assignment keeps this regression callable against the pre-fix one-argument implementation.
  const exportWithId: (doc: Y.Doc, noteId: string) => string = exportDocMarkdown;
  try {
    importBody(doc, `{{3|2|id=${PRICE_ID};name=price}} and {{@(price#${NOTE_ID}#${PRICE_ID})*2|4|id=${DOUBLE_ID};name=double;stale=1}}`);
    const before = Y.encodeStateAsUpdate(doc);
    const markdown = exportWithId(doc, NOTE_ID);
    expect(markdown).toContain(`3|3|id=${PRICE_ID};name=price`);
    expect(markdown).toContain(`)*2|6|id=${DOUBLE_ID};name=double}}`);
    expect(markdown).not.toContain('stale=1');
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    // A foreign note with the same formula id must still use its frozen fallback.
    expect(exportWithId(doc, '9d0c7f3b-5b65-4eb7-b510-8c3b2e170caa')).toContain(`)*2|4|id=${DOUBLE_ID};name=double;stale=1`);
  } finally { doc.destroy(); }
});
