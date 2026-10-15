// Shared by the suggestion spike's tests: the census note, the census operations as real moss editor steps, the
// direct-edit oracle and small Yjs readers. The oracle shares no code with the accept gates: it runs the same steps
// in an editor bound to the body and exports the result.
import { $insertTableRowAtNode, $isTableCellNode, type TableCellNode } from '@lexical/table';
import { $isListItemNode, type ListItemNode } from '@lexical/list';
import {
  $createRangeSelection, $getRoot, $isElementNode, $isParagraphNode, $isTextNode, $parseSerializedNode, $setSelection,
  type LexicalNode, type SerializedLexicalNode, type TextNode,
} from 'lexical';
import { vi } from 'vitest';
import * as Y from 'yjs';
import { importMarkdown } from '../converter/index.ts';
import { attachPayloadDocs, PayloadDocs, payloadDocsFor, payloadMap, payloadText } from '../payload-docs.ts';
import { exportDocMarkdown, importBody, serverWrite } from '../server-doc.ts';
import { bindEditor } from './fork-shim.ts';

export const SUGGESTER = { id: 'suggester-1@example.invalid', name: 'Sam Suggester' };
export const OTHER_SUGGESTER = { id: 'suggester-2@example.invalid', name: 'Sky Suggester' };
export const EDITOR = { id: 'editor-1@example.invalid', role: 'editor' };
export const NOTE_ID = 'census-note';

export const SEED = [
  'Hello world and the cat.',
  '',
  'Go to [the site](https://example.invalid) now.',
  '',
  'First line',
  'second line',
  '',
  'Total {{1+1|2|id=0b6f1d34-8a8e-4f3c-9d55-2f3c1a7e9b10;name=total}} items.',
  '',
  'Indented words here.',
  '',
  '> Quoted words here.',
  '',
  '- [ ] task one',
  '- [ ] task two',
  '',
  '- item a',
  '- item b',
  '',
  '| A | B |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '```js',
  'seed',
  '```',
  '',
  'Join head.',
  '',
  'join tail.',
].join('\n');

/** The census note as the DocDO holds it: imported through the converter, one paragraph indented by an editor. */
export function seededBody(markdown = SEED): Y.Doc {
  const doc = new Y.Doc();
  importBody(doc, markdown);
  serverWrite(doc, 'census-indent', () => {
    for (const node of $getRoot().getChildren()) {
      if ($isParagraphNode(node) && node.getTextContent().startsWith('Indented')) node.setIndent(1);
    }
  });
  return doc;
}

export const all = (node: LexicalNode = $getRoot()): LexicalNode[] =>
  [node, ...($isElementNode(node) ? node.getChildren().flatMap((child) => all(child)) : [])];

export const textNode = (prefix: string): TextNode => {
  const found = all().find((node): node is TextNode => $isTextNode(node) && node.getTextContent().startsWith(prefix));
  if (!found) throw new Error(`no text node starting "${prefix}"`);
  return found;
};

/** A selection inside the text node starting with `prefix`. */
export function select(prefix: string, anchor: number, focus = anchor) {
  const text = textNode(prefix);
  const selection = $createRangeSelection();
  selection.anchor.set(text.getKey(), anchor, 'text');
  selection.focus.set(text.getKey(), focus, 'text');
  $setSelection(selection);
  return selection;
}

export const listItem = (text: string): ListItemNode => {
  const found = all().find((node): node is ListItemNode => $isListItemNode(node) && node.getTextContent() === text);
  if (!found) throw new Error(`no list item "${text}"`);
  return found;
};

const cell = (text: string): TableCellNode => all().find((node): node is TableCellNode => $isTableCellNode(node) && node.getTextContent() === text)!;

export const codeBlock = () => all().find((node) => node.getType() === 'code-block') as unknown as LexicalNode & { setCode(code: string): void };

/** The first block of `markdown`, serialized, as moss's own import makes it. */
function blockFrom(markdown: string): SerializedLexicalNode {
  return (importMarkdown(markdown).getEditorState().toJSON().root.children as SerializedLexicalNode[])[0];
}

/** A new block after the first paragraph, as a paste or slash command inserts it. */
export const insertBlock = (markdown: string) => () => {
  const json = blockFrom(markdown);
  $getRoot().getFirstChildOrThrow().insertAfter($parseSerializedNode(json));
};

export type Step = (() => void) | 'undo';
export interface CensusOp {
  name: string;
  steps: Step[];
}

export const CENSUS: CensusOp[] = [
  { name: 'colliding prefix: "the " before "the cat"', steps: [() => select('Hello', 16).insertText('the ')] },
  { name: 'a duplicated word', steps: [() => select('Hello', 6).insertText('world ')] },
  { name: 'a sentence pasted before itself', steps: [() => select('Hello', 0).insertText('Hello world and the cat. ')] },
  { name: 'Enter mid-paragraph before an original link', steps: [() => select('Go to ', 6).insertParagraph()] },
  { name: 'Enter mid-paragraph before an original line break', steps: [() => select('First line', 10).insertParagraph()] },
  { name: 'Enter mid-paragraph before an inline formula', steps: [() => select('Total ', 6).insertParagraph()] },
  { name: 'Enter in an indented paragraph', steps: [() => select('Indented', 9).insertParagraph()] },
  { name: 'Enter in a quote', steps: [() => select('Quoted', 7).insertParagraph()] },
  { name: 'Shift+Enter', steps: [() => select('Hello', 5).insertLineBreak()] },
  { name: 'bold of own and original text', steps: [() => select('Hello', 24).insertText(' It sat.'), () => select('Hello', 16, 32).formatText('bold')] },
  { name: 'list Enter mid-list', steps: [() => select('item a', 4).insertParagraph()] },
  { name: 'Tab in a list', steps: [() => { const item = listItem('item b'); item.setIndent(item.getIndent() + 1); }] },
  { name: 'table row insert', steps: [() => { $insertTableRowAtNode(cell('1'), true); }] },
  { name: 'checkbox', steps: [() => { listItem('task one').setChecked(true); }] },
  { name: 'new code block', steps: [insertBlock('```js\nnew code\n```')] },
  { name: 'new HTML block', steps: [insertBlock('```moss-html\n<b>new</b>\n```')] },
  { name: 'new formula', steps: [insertBlock('New {{3*3|9}} here.')] },
  { name: 'new chart block', steps: [insertBlock('```moss-chart\n{"type":"bar","data":[{"label":"Mon","value":1}]}\n```')] },
  { name: 'new sketch block', steps: [insertBlock('```moss-sketch\n.##.\n```')] },
  { name: 'an edit of an original code payload', steps: [() => codeBlock().setCode('seed!')] },
  { name: 'undo of a split', steps: [() => select('Hello', 5).insertParagraph(), 'undo'] },
  { name: 'join', steps: [() => select('join tail', 0).deleteCharacter(true)] },
];

let uuid = 0;
/** Register ids and other minted uuids repeat per run, so the fork and the oracle mint the same ones. */
export function deterministicIds(): () => void {
  uuid = 0;
  const spy = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
    uuid += 1;
    return `00000000-0000-4000-8000-${uuid.toString(16).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`;
  });
  // A sketch inking's key tag comes from Math.random (registers.ts); the fork and the oracle encode a different number
  // of times, so every draw is the same and a new inking gets the same tag on both sides.
  const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
  return () => {
    spy.mockRestore();
    random.mockRestore();
  };
}
export const resetIds = () => {
  uuid = 0;
};

/** A new doc holding a copy of every payload `body` holds in memory; the caller fills the note after binding. */
function withPayloadsOf(body: Y.Doc): Y.Doc {
  const doc = new Y.Doc();
  const host = attachPayloadDocs(doc, new PayloadDocs());
  for (const [id, payload] of payloadDocsFor(body).docs) Y.applyUpdate(host.hold(id, true), Y.encodeStateAsUpdate(payload));
  return doc;
}

/** The oracle: an editor bound to a copy of `body` and its payloads makes the steps directly. */
export function directEdit(body: Y.Doc, steps: readonly Step[]): Y.Doc {
  const doc = withPayloadsOf(body);
  const bound = bindEditor(doc);
  try {
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(body));
    bound.editor.update(() => {}, { discrete: true });
    for (const step of steps) {
      if (step === 'undo') bound.undo.undo();
      else bound.editor.update(step, { discrete: true });
      bound.editor.update(() => {}, { discrete: true });
    }
  } finally {
    bound.dispose();
  }
  return doc;
}

/** An editor's direct edit on `live`, its note and payload updates delivered as the provider would. */
export function editorEdits(live: Y.Doc, step: () => void): void {
  const doc = withPayloadsOf(live);
  const payloads = payloadDocsFor(doc);
  const bound = bindEditor(doc);
  try {
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(live));
    bound.editor.update(() => {}, { discrete: true });
    const sv = Y.encodeStateVector(doc);
    const payloadSvs = new Map([...payloads.docs].map(([id, payload]) => [id, Y.encodeStateVector(payload)]));
    bound.editor.update(step, { discrete: true });
    bound.editor.update(() => {}, { discrete: true });
    for (const [id, payload] of payloads.docs) Y.applyUpdate(payloadDocsFor(live).hold(id, true), Y.encodeStateAsUpdate(payload, payloadSvs.get(id)));
    Y.applyUpdate(live, Y.encodeStateAsUpdate(doc, sv));
  } finally {
    bound.dispose();
    payloads.destroy();
    doc.destroy();
  }
}

export const exported = (doc: Y.Doc): string => exportDocMarkdown(doc, NOTE_ID);

/** A payload doc's value as plain data: its text and its compound fields. */
export const payloadValue = (payload: Y.Doc | undefined): unknown =>
  payload ? { text: payloadText(payload).toString(), map: payloadMap(payload).toJSON() } : null;

/** Payload contents in body order, by the decorators naming them. */
export function payloadsInOrder(doc: Y.Doc): string[] {
  const out: string[] = [];
  const payloads = payloadDocsFor(doc);
  const visit = (type: Y.AbstractType<unknown>) => {
    const id = type instanceof Y.XmlText || type instanceof Y.XmlElement ? type.getAttribute('__regId') : undefined;
    if (typeof id === 'string') out.push(JSON.stringify(payloadValue(payloads.get(id))));
    if (type instanceof Y.XmlText) {
      for (const op of type.toDelta() as { insert: unknown }[]) if (op.insert instanceof Y.AbstractType) visit(op.insert);
    } else if (type instanceof Y.XmlElement) for (const child of type.toArray()) visit(child as Y.AbstractType<unknown>);
  };
  visit(doc.get('root', Y.XmlText) as unknown as Y.AbstractType<unknown>);
  return out;
}

/** The body: root, every payload doc the note holds, title and frontmatter as plain data. */
export function bodyOf(doc: Y.Doc): string {
  const payloads = [...payloadDocsFor(doc).docs].sort(([a], [b]) => (a < b ? -1 : 1));
  return JSON.stringify({
    root: doc.get('root', Y.XmlText).toJSON(),
    rootDelta: JSON.stringify(doc.get('root', Y.XmlText).toDelta(), (_k, v: unknown) => (v instanceof Y.AbstractType ? v.toJSON() : v)),
    payloads: payloads.map(([id, payload]) => [id, Array.from(Y.encodeStateAsUpdate(payload)), payloadValue(payload)]),
    title: doc.getText('title').toJSON(),
    frontmatter: doc.getMap('frontmatter').toJSON(),
  });
}

/** Watches `doc` and records the root of every type each transaction changed. */
export function changedRoots(doc: Y.Doc): { roots: Set<string>; stop: () => void } {
  const roots = new Set<string>();
  const handler = (transaction: Y.Transaction) => {
    for (const type of transaction.changed.keys()) {
      let top = type as unknown as Y.AbstractType<unknown>;
      while (top._item) top = top._item.parent as Y.AbstractType<unknown>;
      for (const [name, shared] of doc.share) if (shared === top) roots.add(name);
    }
    for (const [client, ranges] of transaction.deleteSet.clients) {
      for (const range of ranges) {
        for (let clock = range.clock; clock < range.clock + range.len; clock++) {
          const struct = Y.getItem(doc.store, Y.createID(client, clock));
          let top = struct instanceof Y.Item ? (struct.parent as Y.AbstractType<unknown>) : null;
          while (top?._item) top = top._item.parent as Y.AbstractType<unknown>;
          for (const [name, shared] of doc.share) if (shared === top) roots.add(name);
        }
      }
    }
  };
  doc.on('afterTransaction', handler);
  return { roots, stop: () => doc.off('afterTransaction', handler) };
}

/** The Yjs id spans of `text` inside the first live text item containing it, in the top-level block `nth`. */
export function spansOfText(doc: Y.Doc, text: string): { client: number; clock: number; len: number }[] {
  const spans: { client: number; clock: number; len: number }[] = [];
  const walk = (type: Y.AbstractType<unknown>): boolean => {
    let joined = '';
    const chars: Y.ID[] = [];
    for (let item = type._start; item; item = item.right) {
      if (item.deleted) continue;
      if (item.content instanceof Y.ContentString) {
        const str = item.content.str;
        for (let i = 0; i < str.length; i++) {
          joined += str[i];
          chars.push(Y.createID(item.id.client, item.id.clock + i));
        }
      } else if (item.content instanceof Y.ContentType && walk(item.content.type)) return true;
    }
    const at = joined.indexOf(text);
    if (at < 0) return false;
    for (const id of chars.slice(at, at + text.length)) {
      const last = spans.at(-1);
      if (last && last.client === id.client && last.clock + last.len === id.clock) last.len += 1;
      else spans.push({ client: id.client, clock: id.clock, len: 1 });
    }
    return true;
  };
  walk(doc.get('root', Y.XmlText) as unknown as Y.AbstractType<unknown>);
  return spans;
}
