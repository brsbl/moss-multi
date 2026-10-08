// The moss interchange format for files sync tracks in moss mode (A§12): moss saves a note as its frontmatter, a
// leading `# Title` line, then the body with `%%m:<ids>:start%%` / `%%m:<ids>:end%%` markers around each commented
// range, beside a comments.json sidecar. The server holds the clean body; these map one form onto the other. Markers
// move with the text through a character diff, so a comment's markers stay on its words when either side edits.
import { DIFF_DELETE, DIFF_EQUAL, makeDiff, xIndex } from '@sanity/diff-match-patch';

/** moss's modern boundary marker (common/comment-markers.ts). */
const MARKER = /%%m:\s*[A-Za-z0-9_,\-\s]+?\s*:(?:start|end)%%/g;
/** moss's LEADING_H1_RE, anchored to the start of the body. */
const TITLE_LINE = /^#(?!#)[^\S\r\n]+(.*?)(?:[^\S\r\n]+#+)?[^\S\r\n]*(?:\r?\n|$)/;
const BLANK_LINES = /^(?:[^\S\r\n]*\r?\n)*/;

export interface Marker {
  /** Where the marker sits in the clean text. */
  at: number;
  token: string;
}

export interface MossNote {
  /** The leading `# Title` line's text, if the note has one. */
  title: string | undefined;
  /** What the server holds: the frontmatter and body, with no title line and no markers. */
  clean: string;
  markers: Marker[];
}

/** The frontmatter block at the start of `text` (`---` to `---`), or ''. */
function frontmatterOf(text: string): string {
  const match = /^---\r?\n(?:[\s\S]*?\r?\n)?---[^\S\r\n]*(?:\r?\n|$)/.exec(text);
  return match ? match[0] : '';
}

/** Whether `text` carries moss comment markers. */
export const hasMarkers = (text: string): boolean => new RegExp(MARKER.source).test(text);

export function parseMoss(text: string): MossNote {
  const head = frontmatterOf(text);
  let body = text.slice(head.length);
  const lead = BLANK_LINES.exec(body)![0].length;
  const line = TITLE_LINE.exec(body.slice(lead));
  const title = line?.[1]?.trim() || undefined;
  if (line && title) body = body.slice(lead + line[0].length).replace(BLANK_LINES, '');
  const withMarkers = head + body;
  const markers: Marker[] = [];
  let clean = '';
  let last = 0;
  for (const match of withMarkers.matchAll(MARKER)) {
    clean += withMarkers.slice(last, match.index);
    markers.push({ at: clean.length, token: match[0] });
    last = match.index + match[0].length;
  }
  clean += withMarkers.slice(last);
  return { title, clean, markers };
}

/**
 * Carries `markers` from `from` onto `to`. A pair whose text was deleted entirely is dropped, as moss drops a
 * comment's markers when its words go; the record stays in comments.json.
 */
export function remapMarkers(markers: Marker[], from: string, to: string): Marker[] {
  if (markers.length === 0) return [];
  if (from === to) return markers;
  const diffs = makeDiff(from, to);
  // Pair each start with its end; a pair none of whose characters survive is dropped.
  const dropped = new Set<number>();
  const open = new Map<string, number[]>();
  markers.forEach((marker, i) => {
    const ids = marker.token.replace(/:(?:start|end)%%$/, '');
    if (marker.token.endsWith(':start%%')) {
      open.set(ids, [...(open.get(ids) ?? []), i]);
      return;
    }
    const start = open.get(ids)?.pop();
    if (start === undefined) return;
    const first = markers[start]!.at;
    if (first < marker.at && !survives(diffs, first, marker.at)) dropped.add(start).add(i);
  });
  return markers.flatMap((marker, i) => (dropped.has(i) ? [] : [{ ...marker, at: xIndex(diffs, marker.at) }]));
}

/** Whether any character of `from`'s [start, end) is still in the new text. */
function survives(diffs: ReturnType<typeof makeDiff>, start: number, end: number): boolean {
  let at = 0;
  for (const [op, text] of diffs) {
    if (op === DIFF_DELETE || op === DIFF_EQUAL) {
      if (op === DIFF_EQUAL && at < end && at + text.length > start) return true;
      at += text.length;
    }
  }
  return false;
}

/** The note as moss saves it: frontmatter, the `# Title` line, then the body with `markers` put back. */
export function renderMoss(clean: string, title: string, markers: Marker[]): string {
  let text = '';
  let last = 0;
  for (const marker of [...markers].sort((a, b) => a.at - b.at)) {
    text += clean.slice(last, marker.at) + marker.token;
    last = marker.at;
  }
  text += clean.slice(last);
  const head = frontmatterOf(text);
  const body = text.slice(head.length).replace(BLANK_LINES, '');
  return title.trim() ? `${head}# ${title.trim()}\n\n${body}` : head + body;
}
