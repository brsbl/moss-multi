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
