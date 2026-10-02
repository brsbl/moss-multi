// SP2 measurement Worker (A§22): the converter alone in workerd, driven by scripts/measure-converter.mjs.
import { createBinding, syncLexicalUpdateToYjs, type Provider } from '@lexical/yjs';
import type { LexicalEditor } from 'lexical';
import * as Y from 'yjs';
import { $importNoteBody, createConverterEditor, exportMarkdown, importMarkdown } from '../src/converter/index.ts';

let imported: LexicalEditor | null = null;

// A headless binding needs a provider; nothing here talks to one.
const awareness = {
  getLocalState: () => null,
  getStates: () => new Map(),
  on: () => {},
  off: () => {},
  setLocalState: () => {},
  setLocalStateField: () => {},
};
const provider = { awareness, connect: () => {}, disconnect: () => {}, on: () => {}, off: () => {} } as unknown as Provider;

// Bytes of the Y.Doc state the binding writes for this markdown.
function stateBytes(markdown: string): number {
  const doc = new Y.Doc();
  const editor = createConverterEditor();
  const binding = createBinding(editor, provider, 'root', doc, new Map([['root', doc]]));
  const stop = editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
  });
  editor.update(() => $importNoteBody(markdown), { discrete: true });
  stop();
  return Y.encodeStateAsUpdate(doc).byteLength;
}

const utf8 = (text: string) => new TextEncoder().encode(text).byteLength;

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/ping') return new Response('ok');
    if (pathname === '/import') {
      const markdown = await request.text();
      imported = importMarkdown(markdown);
      return Response.json({ bytes: utf8(markdown) });
    }
    if (pathname === '/export') {
      if (!imported) return new Response('import first', { status: 409 });
      return Response.json({ bytes: utf8(exportMarkdown(imported)) });
    }
    if (pathname === '/state') {
      const markdown = await request.text();
      return Response.json({ markdownBytes: utf8(markdown), stateBytes: stateBytes(markdown) });
    }
    return new Response('not found', { status: 404 });
  },
};
