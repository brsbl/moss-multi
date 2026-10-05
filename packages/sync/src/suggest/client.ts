// The suggest-mode client (docs/design/suggestions.md §5): the fork F and the composite C. Tests first: not built yet.
import * as Y from 'yjs';
import type { IdSpan, SuggestReply, SuggestRefusal, SuggestRequest } from '@moss-multi/protocol/suggest';

export type ForkEvent = { type: 'ready' } | { type: 'change' } | { type: 'refused'; reason: SuggestRefusal; unsaved: string[] };

export interface ForkOptions {
  me: string;
  name: string;
  send: (request: SuggestRequest) => void;
}

export class SuggestFork {
  readonly doc = new Y.Doc();
  ready = false;
  closed = false;
  sent = 0;

  constructor(readonly body: Y.Doc, readonly options: ForkOptions) {}

  on(_listener: (event: ForkEvent) => void): () => void {
    return () => {};
  }

  begin(): void {}

  receive(_reply: SuggestReply): void {}

  proposeDelete(_targets: IdSpan[], _quote: string): boolean {
    return false;
  }

  isStruck(_id: { client: number; clock: number }): boolean {
    return false;
  }

  dispose(): void {
    this.doc.destroy();
  }
}

export class Composite {
  constructor(readonly body: Y.Doc) {}

  build(): { doc: Y.Doc; valid: string[]; broken: string[] } {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(this.body));
    return { doc, valid: [], broken: [] };
  }
}

export function reviewDoc(body: Y.Doc, _composite: Composite, bind: (doc: Y.Doc) => void): 'composite' | 'body' {
  bind(body);
  return 'body';
}
