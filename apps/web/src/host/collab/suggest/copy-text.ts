// "Copy suggested text" (docs/design/suggestions.md §4.7): what an outdated or broken record proposes, as text.
import { BODY_DOC, hydrate, type SuggestionRecord } from '@moss-multi/core/suggest/apply';
import { payloadDocsFor, PAYLOAD_TEXT } from '@moss-multi/sync/payload-docs';
import * as Y from 'yjs';

type Spans = Map<number, [number, number][]>;

const addSpan = (spans: Spans, client: number, from: number, to: number) => {
  const list = spans.get(client);
  if (list) list.push([from, to]);
  else spans.set(client, [[from, to]]);
};

/** Each client's spans sorted and merged, for a search by halves. */
function merged(spans: Spans): Spans {
  const out: Spans = new Map();
  for (const [client, list] of spans) {
    list.sort((a, b) => a[0] - b[0]);
    const runs: [number, number][] = [];
    for (const [from, to] of list) {
      const last = runs.at(-1);
      if (last && from <= last[1]) last[1] = Math.max(last[1], to);
      else runs.push([from, to]);
    }
    out.set(client, runs);
  }
  return out;
}

function covers(spans: Spans, client: number, clock: number): boolean {
  const runs = spans.get(client);
  if (!runs) return false;
  let lo = 0;
  let hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid][1] <= clock) lo = mid + 1;
    else hi = mid;
  }
  return lo < runs.length && runs[lo][0] <= clock;
}

/**
 * The text a record proposes, as it stands: every character it wrote that its own later ops did not remove, read in
 * document order from a copy of the note with the record applied, each payload's text where the block naming it
 * stands (a payload no live block names follows, in op order). Runs in separate places are separate lines; nothing is
 * trimmed. A record that can no longer be applied (outdated or broken: its paragraph removed, its payload missing)
 * keeps what it typed: characters that did not land in the copy follow, in the order the author wrote them.
 */
export function suggestedText(record: SuggestionRecord, body?: Y.Doc | null): string {
  const clients = new Set(record.meta.clients);
  const own = new Map<string, Spans>();
  const typed: { doc: string; client: number; clock: number; str: string }[] = [];
  const docs = new Map<string, { doc: Y.Doc; before: Map<number, number> }>();
  const docFor = (id: string) => {
    let held = docs.get(id);
    if (!held) {
      const source = !body ? undefined : id === BODY_DOC ? body : payloadDocsFor(body).get(id);
      const doc = source ? hydrate(source) : new Y.Doc({ gc: false });
      held = { doc, before: Y.decodeStateVector(Y.encodeStateVector(doc)) };
      docs.set(id, held);
    }
    return held;
  };
  if (body) docFor(BODY_DOC);
  for (const op of record.ops) {
    let decoded: ReturnType<typeof Y.decodeUpdate>;
    try {
      decoded = Y.decodeUpdate(op.update);
    } catch {
      continue;
    }
    const spans = own.get(op.doc) ?? new Map();
    own.set(op.doc, spans);
    for (const [client, list] of decoded.ds.clients) for (const { clock, len } of list) addSpan(spans, client, clock, clock + len);
    for (const struct of decoded.structs) {
      if (struct instanceof Y.Item && struct.content instanceof Y.ContentString && clients.has(struct.id.client)) {
        typed.push({ doc: op.doc, client: struct.id.client, clock: struct.id.clock, str: struct.content.str });
      }
    }
    if (!body) continue;
    const { doc } = docFor(op.doc);
    try {
      Y.applyUpdate(doc, op.update);
    } catch {
      // An op that cannot be applied leaves its text to the fallback below.
    }
  }
  const removed = new Map([...own].map(([doc, spans]) => [doc, merged(spans)]));
  const proposed = (doc: string, client: number, clock: number) => {
    const before = docs.get(doc)?.before.get(client) ?? 0;
    return clients.has(client) && clock >= before && !covers(removed.get(doc) ?? new Map(), client, clock);
  };

  const lines: string[] = [];
  const shown = new Set<string>();
  let run = '';
  const flush = () => {
    if (run) lines.push(run);
    run = '';
  };
  /** A run of text: the record's own characters that survive join the run; anyone else's live text ends it. */
  const read = (id: string, item: Y.Item, str: string) => {
    const before = docs.get(id)?.before.get(item.id.client) ?? 0;
    if (!clients.has(item.id.client) || item.id.clock < before) {
      if (!item.deleted) flush();
      return;
    }
    for (let i = 0; i < str.length; i += 1) {
      const clock = item.id.clock + i;
      shown.add(`${id}:${item.id.client}:${clock}`);
      if (proposed(id, item.id.client, clock)) run += str[i];
    }
  };
  const payloads = new Set(record.ops.filter((op) => op.doc !== BODY_DOC).map((op) => op.doc));
  const walked = new Set<string>();
  const walkPayload = (id: string) => {
    if (walked.has(id) || !docs.has(id)) return;
    walked.add(id);
    flush();
    const text = docs.get(id)!.doc.share.get(PAYLOAD_TEXT);
    for (let item = text?._start ?? null; item; item = item.right) if (item.content instanceof Y.ContentString) read(id, item, item.content.str);
    flush();
  };
  // Depth first without recursion: each item in sequence order, a block's items (then the end of the block) before
  // its next sibling.
  const END = 'end';
  const walkBody = (start: Y.AbstractType<unknown>) => {
    const stack: (Y.Item | null | typeof END)[] = [start._start];
    while (stack.length) {
      const item = stack.pop();
      if (item === END) flush();
      if (!item || item === END) continue;
      stack.push(item.right);
      const content = item.content;
      if (content instanceof Y.ContentString) {
        read(BODY_DOC, item, content.str);
      } else if (content instanceof Y.ContentType) {
        const type = content.type as Y.AbstractType<unknown>;
        if (type instanceof Y.Map) {
          // A text node's map sits inside a run; a line break or a tab reads as one.
          const kind = type._map.get('__type')?.content.getContent()[0];
          const ch = kind === 'linebreak' ? '\n' : kind === 'tab' ? '\t' : '';
          if (ch && proposed(BODY_DOC, item.id.client, item.id.clock)) run += ch;
          else if (ch && !item.deleted) flush();
          continue;
        }
        flush();
        const named = type._map.get('__regId')?.content.getContent()[0];
        if (typeof named === 'string' && payloads.has(named)) walkPayload(named);
        stack.push(END);
        stack.push(type._start);
      } else if (content instanceof Y.ContentEmbed && !item.deleted) {
        flush();
      }
    }
  };
  if (body) {
    const root = docs.get(BODY_DOC)?.doc.share.get('root');
    if (root) walkBody(root);
    flush();
    for (const id of payloads) walkPayload(id);
  }
  // What did not land in the copy, in the order it was written.
  for (const { doc, client, clock, str } of typed) {
    for (let i = 0; i < str.length; i += 1) {
      if (!shown.has(`${doc}:${client}:${clock + i}`) && proposed(doc, client, clock + i)) run += str[i];
    }
  }
  flush();
  for (const { doc } of docs.values()) doc.destroy();
  return lines.join('\n');
}
