// Comment anchors on the V1 tree (A§13; docs/design/comments.md): RelativePositions plus a quote over one projection.
import * as Y from 'yjs';

export interface TextQuote {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface TreeAnchor {
  start: string;
  end: string;
  quote: TextQuote;
  hint: number;
  status: 'anchored' | 'orphaned';
}

export interface Range {
  start: number;
  end: number;
}

export interface Projection {
  text: string;
}

export const decodeRelPos = (value: string): Y.RelativePosition => Y.decodeRelativePosition(new Uint8Array(value.length));

export function project(_doc: Y.Doc): Projection {
  return { text: '' };
}

export function mintAnchor(_doc: Y.Doc, start: number, end: number): TreeAnchor {
  return { start: '', end: '', quote: { exact: '', prefix: '', suffix: '' }, hint: start + end, status: 'orphaned' };
}

export function resolveAnchor(_doc: Y.Doc, _anchor: TreeAnchor): Range | null {
  return null;
}

export function validateAnchor(_doc: Y.Doc, anchor: TreeAnchor): { anchor: TreeAnchor; range: Range | null; reanchored: boolean } {
  return { anchor, range: null, reanchored: false };
}
