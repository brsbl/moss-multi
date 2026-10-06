import {
  $convertFromMarkdownString as $lexicalConvertFromMarkdownString,
  TRANSFORMERS,
  type TextFormatTransformer,
  type TextMatchTransformer,
  type Transformer,
} from '@lexical/markdown';
import { $createTextNode, $getSelection, $isRangeSelection, $isTextNode, type ElementNode, type LexicalNode, type TextNode } from 'lexical';
import {
  COLOR_TRANSFORMER_IMPORT_REGEXP,
  isAfterUnclosedBacktick as isAfterUnclosedBacktickIn,
  isInsideInlineCodeSpan as isInsideInlineCodeSpanIn,
} from '../utils/color-codes';

// Lexical's markdown import with a linear inline pass (A§12; SP2). @lexical/markdown 0.48 imports each line's text
// by finding the outermost format or text match over the whole text, splitting there and recursing on each part:
// every match rescans the rest of the line, recurses once (about 10k matches overflow the stack) and pays
// TextNode.splitText's walk from the paragraph's first child, so one line of many matches costs O(matches × length)
// and moss's replace callbacks add their own scans of the text. Here Lexical still parses blocks; its inline pass
// gets a single driver transformer, which runs the same algorithm on an explicit stack: the same matches, in the
// same order, through the same transformer callbacks, so the tree is the one Lexical builds. What changes is cost:
// a part after a match is a suffix of the text already scanned, so each text-match regex keeps its next match and is
// rerun only once that match is passed; the format search decides from a short prefix when the rest cannot change
// the answer, and reuses its answer when only text without delimiters was consumed; the split links the new nodes in
// place. A line still over its work budget (LINEAR_IMPORT_LIMITS: pathological nesting, or replace callbacks that
// scan the whole paragraph per match) keeps the rest of its text as written, unconverted.
// linear-import.golden.test.ts holds this to Lexical's own import over the corpus and fuzz.

/**
 * Work budgets, in rough character operations: per line, perChar × the line's length + base; per import (nested
 * imports, such as table cells, share their outer import's), perChar × the markdown's length + importBase.
 */
export const LINEAR_IMPORT_LIMITS = { perChar: 256, base: 1 << 20, importBase: 1 << 22 };
/** Lines whose budget ran out (left partly unconverted), over all imports. */
export const linearImportStats = { cut: 0 };

// Rough costs, in character operations, of Lexical node work.
const VISIT_COST = 32;
const APPLY_COST = 1024;
// Native regex and string scans run several characters per operation.
const NATIVE = 4;
// The first prefix the format search tries, grown fourfold.
const FIRST_WINDOW = 64;

/** Lexical's $convertFromMarkdownString, with the inline pass made linear. */
export function $convertFromMarkdownString(
  markdown: string,
  transformers: Transformer[] = TRANSFORMERS,
  node?: ElementNode,
  shouldPreserveNewLines = false,
  shouldMergeAdjacentLines = false,
): void {
  const outer = importBudget;
  importBudget ??= new Budget(LINEAR_IMPORT_LIMITS.perChar * markdown.length + LINEAR_IMPORT_LIMITS.importBase);
  try {
    $lexicalConvertFromMarkdownString(markdown, importTransformers(transformers), node, shouldPreserveNewLines, shouldMergeAdjacentLines);
  } finally {
    importBudget = outer;
  }
}

// The budget of the import running, if any.
let importBudget: Budget | null = null;

// moss's raw-URL and color callbacks call these once per match, on the text of the match's part. Neither can be
// true without a backtick before the offset, so that is looked for first and the scan of the whole text skipped.
export function isInsideInlineCodeSpan(text: string, offset: number): boolean {
  return backtickBefore(text, offset) && isInsideInlineCodeSpanIn(text, offset);
}

export function isAfterUnclosedBacktick(text: string, offset: number): boolean {
  return backtickBefore(text, offset) && isAfterUnclosedBacktickIn(text, offset);
}

function backtickBefore(text: string, offset: number): boolean {
  const target = Math.max(0, Math.min(offset, text.length));
  return target > 0 && text.lastIndexOf('`', target - 1) >= 0;
}

const IMPORT_LISTS = new WeakMap<Transformer[], Transformer[]>();

// The block transformers as given, then one text-match driver for the inline pass. Lexical's own inline pass then
// sees no formats and one match covering each line's text, and hands that text to the driver.
function importTransformers(transformers: Transformer[]): Transformer[] {
  let list = IMPORT_LISTS.get(transformers);
  if (!list) {
    const formats = transformers.filter((t): t is TextFormatTransformer => t.type === 'text-format');
    const matchers = transformers.filter((t): t is TextMatchTransformer => t.type === 'text-match');
    const index = formatIndex(formats);
    const driver: TextMatchTransformer = {
      dependencies: [],
      importRegExp: /[\s\S]+/,
      regExp: /(?!)$/,
      replace: (textNode) => {
        $importInline(textNode, index, matchers);
      },
      type: 'text-match',
    };
    list = [...transformers.filter((t) => t.type !== 'text-format' && t.type !== 'text-match'), driver];
    IMPORT_LISTS.set(transformers, list);
  }
  return list;
}

// ---- Budget ----

const OVER_BUDGET = Symbol('over budget');

class Budget {
  left: number;
  constructor(total: number) {
    this.left = total;
  }
  /** Spends without stopping; the next check stops. */
  charge(cost: number): void {
    this.left -= cost;
  }
  /** Spends, and stops the line once the budget is gone. */
  spend(cost: number): void {
    this.left -= cost;
    if (this.left < 0) throw OVER_BUDGET;
  }
}

// ---- The inline pass (Lexical's importTextTransformers, on an explicit stack) ----

interface Visit {
  node: LexicalNode | undefined;
  /** The text this node's text is a suffix of, when known. */
  context: Context | null;
  offset: number;
  top?: boolean;
}
type Frame = Visit | { unescape: TextNode };

interface Split {
  transformedNode?: TextNode;
  nodeBefore: TextNode | undefined;
  nodeAfter: TextNode | undefined;
}

// Lexical's outer call already unescapes the top node after the driver returns, so the top gets no unescape here.
function $importInline(top: TextNode, index: FormatIndex, matchers: TextMatchTransformer[]): void {
  const lineLength = top.getTextContentSize();
  const lineLimit = LINEAR_IMPORT_LIMITS.perChar * lineLength + LINEAR_IMPORT_LIMITS.base;
  const budget = new Budget(importBudget ? Math.min(lineLimit, importBudget.left) : lineLimit);
  const total = budget.left;
  let applied = 0;
  const replaceCost = (transformer: TextMatchTransformer, match: RegExpMatchArray) => {
    const start = match.index ?? 0;
    const input = match.input ?? '';
    const read = REPLACE_READS.get(transformer.importRegExp?.source ?? '');
    if (read === 'match') return (start + match[0].length) / NATIVE;
    // Two scans of the whole text, character by character.
    if (read === 'backticks') return (start + match[0].length) / NATIVE + (backtickBefore(input, start) ? 4 * input.length : 0);
    // Others may read the whole paragraph several times over: its text, and its children (about one per match so far).
    return 8 * (lineLength + applied);
  };
  const stack: Frame[] = [{ node: top, context: null, offset: 0, top: true }];
  try {
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if ('unescape' in frame) {
        budget.charge(frame.unescape.getTextContentSize() / NATIVE);
        $unescape(frame.unescape);
        continue;
      }
      const node = frame.node;
      if (!frame.top && !canContainTransformableMarkdown(node)) continue;
      const textNode = node as TextNode;
      budget.spend(VISIT_COST);
      const text = textNode.getTextContent();
      let context = frame.context;
      let offset = frame.offset;
      if (context === null || context.base.length - offset !== text.length) {
        context = newContext(text);
        offset = 0;
      }
      let foundFormat = findFormat(text, context, offset, index, budget);
      let foundMatch = findMatch(textNode, text, context, offset, matchers, budget);

      if (foundFormat && foundMatch) {
        if (foundFormat.isCodeSpan) {
          if (foundMatch.startIndex <= foundFormat.startIndex && foundMatch.endIndex >= foundFormat.endIndex) foundFormat = null;
          else foundMatch = null;
        } else if (
          (foundFormat.startIndex <= foundMatch.startIndex && foundFormat.endIndex >= foundMatch.endIndex) ||
          foundMatch.startIndex > foundFormat.endIndex
        ) {
          foundMatch = null;
        } else {
          foundFormat = null;
        }
      }

      let result: Split;
      let endIndex: number;
      if (foundFormat) {
        applied += 1;
        budget.charge(APPLY_COST);
        result = $importFormat(textNode, foundFormat);
        endIndex = foundFormat.endIndex;
      } else if (foundMatch) {
        applied += 1;
        budget.charge(APPLY_COST + replaceCost(foundMatch.transformer, foundMatch.match));
        result = $importMatch(textNode, foundMatch);
        endIndex = foundMatch.endIndex;
      } else {
        if (!frame.top) stack.push({ unescape: textNode });
        continue;
      }
      // Lexical recurses into the part after, the part before and the transformed node, then unescapes this node.
      if (!frame.top) stack.push({ unescape: textNode });
      stack.push({ node: result.transformedNode, context: null, offset: 0 });
      stack.push({ node: result.nodeBefore, context: null, offset: 0 });
      stack.push({ node: result.nodeAfter, context, offset: offset + endIndex });
    }
  } catch (error) {
    if (error !== OVER_BUDGET) throw error;
    linearImportStats.cut += 1;
  } finally {
    if (importBudget && Number.isFinite(total)) importBudget.left -= total - budget.left;
  }
}

function canContainTransformableMarkdown(node: LexicalNode | undefined): node is TextNode {
  return $isTextNode(node) && !node.hasFormat('code');
}

function $unescape(node: TextNode): void {
  node.setTextContent(unescapeText(node.getTextContent()));
}

// Lexical's unescapeText.
function unescapeText(value: string): string {
  return value.replace(/\\([!-/:-@[-`{-~])/g, '$1').replace(/&#(\d+);/g, (_, codePoint) => String.fromCodePoint(Number(codePoint)));
}

// TextNode.splitText(...offsets) for a node in a parent with no range selection: the same nodes, linked in after
// the first part instead of spliced at the node's index (splitText walks to it from the first child).
function $split(node: TextNode, offsets: number[]): TextNode[] {
  const plain = node.getParent() !== null && !$isRangeSelection($getSelection()) && !node.isSegmented();
  if (!plain || (node as unknown as { __state?: unknown }).__state !== undefined) return node.splitText(...offsets);
  const text = node.getTextContent();
  if (text === '') return [];
  const ends = [...offsets].sort((a, b) => a - b);
  ends.push(text.length);
  const parts: string[] = [];
  for (let start = 0, i = 0; start < text.length && i < ends.length; i += 1) {
    if (ends[i] > start) {
      parts.push(text.slice(start, ends[i]));
      start = ends[i];
    }
  }
  if (parts.length === 1) return [node];
  const format = node.getFormat();
  const style = node.getStyle();
  const detail = node.getDetail();
  const first = node.setTextContent(parts[0]);
  const nodes = [first];
  let previous = first;
  for (let i = 1; i < parts.length; i += 1) {
    const sibling = $createTextNode(parts[i]);
    sibling.setFormat(format);
    sibling.setStyle(style);
    sibling.setDetail(detail);
    previous.insertAfter(sibling, false);
    nodes.push(sibling);
    previous = sibling;
  }
  return nodes;
}

// Lexical's importTextFormatTransformer.
function $importFormat(textNode: TextNode, found: FoundFormat): Split {
  const { startIndex, endIndex, transformer, match } = found;
  const textContent = textNode.getTextContent();
  let transformedNode: TextNode;
  let nodeAfter: TextNode | undefined;
  let nodeBefore: TextNode | undefined;
  if (match[0] === textContent) {
    transformedNode = textNode;
  } else if (startIndex === 0) {
    [transformedNode, nodeAfter] = $split(textNode, [endIndex]);
  } else {
    [nodeBefore, transformedNode, nodeAfter] = $split(textNode, [startIndex, endIndex]);
  }
  transformedNode.setTextContent(match[2]);
  if (transformer) {
    for (const format of transformer.format) {
      if (!transformedNode.hasFormat(format)) transformedNode.toggleFormat(format);
    }
  }
  return { nodeAfter, nodeBefore, transformedNode };
}

// Lexical's importFoundTextMatchTransformer (every listed transformer has a replace).
function $importMatch(textNode: TextNode, found: FoundMatch): Split {
  const { startIndex, endIndex, transformer, match } = found;
  let transformedNode: TextNode;
  let nodeAfter: TextNode | undefined;
  let nodeBefore: TextNode | undefined;
  if (startIndex === 0) {
    [transformedNode, nodeAfter] = $split(textNode, [endIndex]);
  } else {
    [nodeBefore, transformedNode, nodeAfter] = $split(textNode, [startIndex, endIndex]);
  }
  const replaced = transformer.replace!(transformedNode, match);
  return { nodeAfter, nodeBefore, transformedNode: replaced || undefined };
}

// ---- Contexts: what is known about a text whose suffixes are imported in turn ----

interface CachedMatch {
  /** The offset it was searched from; no match starts between it and `at`. */
  from: number;
  /** Where the match starts in the base, or -1 for none. */
  at: number;
  match: RegExpMatchArray | null;
  /** getEndIndex minus the start, once asked. */
  endDelta?: number | false;
}

interface Context {
  base: string;
  matches: Map<TextMatchTransformer, CachedMatch>;
  scan?: ContextScan;
  /** The last format search computed in full, by the offset it was computed at. */
  format?: { at: number; result: FoundFormat | null; quietUntil: number };
}

interface ContextScan {
  /** Last index of a delimiter character or backtick, or -1. */
  lastRelevant: number;
  /** Last index of an unescaped backtick run with a later run of the same length, or -1. */
  lastSpanOpener: number;
}

const newContext = (base: string): Context => ({ base, matches: new Map() });

// ---- Text matches (Lexical's findOutermostTextMatchTransformer) ----

interface FoundMatch {
  startIndex: number;
  endIndex: number;
  transformer: TextMatchTransformer;
  match: RegExpMatchArray;
}

function findMatch(node: TextNode, text: string, context: Context, offset: number, matchers: TextMatchTransformer[], budget: Budget): FoundMatch | null {
  let found: FoundMatch | null = null;
  for (const transformer of matchers) {
    if (!transformer.replace || !transformer.importRegExp) continue;
    const cached = matchAt(text, context, offset, transformer, budget);
    if (!cached) continue;
    const { entry, match } = cached;
    const startIndex = match.index || 0;
    let endIndex: number | false;
    if (transformer.getEndIndex) {
      // moss's getEndIndex reads only the match, so its answer moves with the match.
      if (entry) {
        if (entry.endDelta === undefined) {
          const end = transformer.getEndIndex(node, match);
          budget.charge(match[0].length / NATIVE);
          entry.endDelta = end === false ? false : end - startIndex;
        }
        endIndex = entry.endDelta === false ? false : startIndex + entry.endDelta;
      } else {
        endIndex = transformer.getEndIndex(node, match);
      }
    } else {
      endIndex = startIndex + match[0].length;
    }
    if (endIndex === false) continue;
    if (found === null || (startIndex < found.startIndex && (endIndex > found.endIndex || endIndex <= found.startIndex))) {
      found = { startIndex, endIndex, transformer, match };
    }
  }
  return found;
}

// The transformer's match in `text` (the base from `offset`): the cached one while it is still ahead, else a fresh
// `text.match` as Lexical runs it. Returned with its index and input as a match on `text` would have them.
function matchAt(
  text: string,
  context: Context,
  offset: number,
  transformer: TextMatchTransformer,
  budget: Budget,
): { entry: CachedMatch | null; match: RegExpMatchArray } | null {
  const re = transformer.importRegExp!;
  const kind = regExpKind(re);
  if (kind.suffixSafe) {
    let entry = context.matches.get(transformer);
    if (!entry || entry.from > offset || (entry.at >= 0 && entry.at < offset)) {
      budget.spend(0);
      const match = text.match(re);
      budget.charge((match ? (match.index ?? 0) + match[0].length : text.length) / NATIVE + 1);
      entry = { from: offset, at: match ? offset + (match.index ?? 0) : -1, match };
      context.matches.set(transformer, entry);
      if (match) return { entry, match };
    }
    if (entry.at < 0 || !entry.match) return null;
    return { entry, match: rebase(entry.match, entry.at - offset, text) };
  }
  budget.spend(0);
  const match = text.match(re);
  const scanned = kind.firstLiteral !== null && text[0] !== kind.firstLiteral ? 1 : text.length / NATIVE;
  budget.charge((match ? match[0].length / NATIVE : scanned) + 1);
  return match ? { entry: null, match } : null;
}

function rebase(match: RegExpMatchArray, index: number, input: string): RegExpMatchArray {
  const copy = [...match] as RegExpMatchArray;
  copy.index = index;
  copy.input = input;
  copy.groups = match.groups;
  return copy;
}

interface RegExpKind {
  /** Matching at a position reads nothing before it, so a suffix matches where the whole text does. */
  suffixSafe: boolean;
  /** For a `^`-anchored regex, the literal character it starts with, if any. */
  firstLiteral: string | null;
}

const KINDS = new WeakMap<RegExp, RegExpKind>();
// The color regex's `\b` follows its hex digits, so it never reads before the match.
const SUFFIX_SAFE = new Set([COLOR_TRANSFORMER_IMPORT_REGEXP.source]);
const SPECIAL = new Set([...'\\^$.|?*+()[]{}']);

// Suffix-safe: no `^`, no `\b` or `\B`, no lookbehind, not global, sticky or multiline.
function regExpKind(re: RegExp): RegExpKind {
  let kind = KINDS.get(re);
  if (kind) return kind;
  const source = re.source;
  let unsafe = re.global || re.sticky || re.multiline;
  let carets = 0;
  let depth = 0;
  let topLevelAlternative = false;
  let inClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '\\') {
      if (!inClass && (source[i + 1] === 'b' || source[i + 1] === 'B')) unsafe = true;
      i += 1;
    } else if (inClass) {
      if (char === ']') inClass = false;
    } else if (char === '[') {
      inClass = true;
      if (source[i + 1] === '^') i += 1;
    } else if (char === '(') {
      if (source.startsWith('(?<=', i) || source.startsWith('(?<!', i)) unsafe = true;
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (char === '|' && depth === 0) {
      topLevelAlternative = true;
    } else if (char === '^') {
      carets += 1;
    }
  }
  const anchored = !unsafe && carets === 1 && source[0] === '^' && !topLevelAlternative;
  const first = source[1];
  kind = {
    suffixSafe: (!unsafe && carets === 0) || (SUFFIX_SAFE.has(source) && !re.global && !re.sticky),
    firstLiteral: anchored && first !== undefined && !SPECIAL.has(first) ? first : null,
  };
  KINDS.set(re, kind);
  return kind;
}

// What a replace callback reads besides the match: the text up to it ('match'), or also the whole text when a
// backtick precedes the match ('backticks', the raw-URL callback). Others are charged a scan of the paragraph.
const READS_MATCH = [
  String.raw`<u(?:\s+style="([^"]*font-family\s*:[^"]*serif[^"]*)")?>([^<]+)<\/u>`,
  String.raw`<mark data-color="(\w+)"(?:\s+style="([^"]*font-family\s*:[^"]*serif[^"]*)")?>([^<]+)<\/mark>`,
  String.raw`==(?:<span style="([^"]*font-family\s*:[^"]*serif[^"]*)">([^<]+)<\/span>|([^=\n]+))==`,
  String.raw`\{\{([^{}\n]+)\}\}`,
  String.raw`\?\[((?:\\.|[^\]\\])*)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)`,
  String.raw`(~~\*\*\*|\*\*\*~~|~~\*\*|\*\*~~|~~\*|\*~~|\*\*\*|\*\*|~~|\*)(?:(\?\[((?:\\.|[^\]\\])*)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\))|(https?:\/\/[^\s<>{}|\\^[\]` +
    '`' +
    String.raw`*~]+))(~~\*\*\*|\*\*\*~~|~~\*\*|\*\*~~|~~\*|\*~~|\*\*\*|\*\*|~~|\*)`,
  String.raw`\[((?:https?:\/\/[^\]\s]+))\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)`,
  String.raw`\[\[((?:[^\]]|\](?!\]))+)\]\]`,
  String.raw`(?:\[([^[\]]+)\])(?:\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)(?:\s"((?:[^"]*\\")*[^"]*)")?\))`,
  String.raw`(?:\[(.+?)\])(?:\((?:([^()\s]+)(?:\s"((?:[^"]*\\")*[^"]*)"\s*)?)\))`,
];
const REPLACE_READS = new Map<string, 'match' | 'backticks'>([
  ...READS_MATCH.map((source) => [source, 'match'] as const),
  [String.raw`https?:\/\/[^\s<>{}|\\^[\]` + '`' + ']+', 'backticks'],
]);

// ---- Formats (Lexical's findOutermostTextFormatTransformer) ----

interface FormatIndex {
  byTag: Record<string, TextFormatTransformer>;
  code: TextFormatTransformer | undefined;
  delimiterChars: Set<string>;
  /** Per delimiter character, its tags longest first (ties in index order). */
  tagsByChar: Map<string, string[]>;
}

function formatIndex(formats: TextFormatTransformer[]): FormatIndex {
  const byTag: Record<string, TextFormatTransformer> = {};
  for (const transformer of formats) byTag[transformer.tag] = transformer;
  const tags = Object.keys(byTag);
  const delimiterChars = new Set(tags.filter((tag) => tag[0] !== '`').map((tag) => tag[0]));
  const tagsByChar = new Map<string, string[]>();
  for (const char of delimiterChars) {
    tagsByChar.set(
      char,
      tags.filter((tag) => tag[0] === char).sort((a, b) => b.length - a.length),
    );
  }
  return { byTag, code: byTag['`'], delimiterChars, tagsByChar };
}

interface FoundFormat {
  startIndex: number;
  endIndex: number;
  transformer: TextFormatTransformer;
  match: RegExpMatchArray;
  isCodeSpan: boolean;
}

interface Span {
  startIndex: number;
  endIndex: number;
  content: string;
}

interface Delimiter {
  index: number;
  char: string;
  length: number;
  canOpen: boolean;
  canClose: boolean;
  active: boolean;
}

interface Emphasis {
  startIndex: number;
  endIndex: number;
  tag: string;
  content: string;
}

const isRelevant = (index: FormatIndex, char: string) => char === '`' || index.delimiterChars.has(char);

// The search on `text`, the base from `offset`, answered (in order) by: no delimiter or backtick left; the last
// answer, when only text without delimiters, backticks or backslashes was consumed since; a prefix whose answer the
// rest cannot change; the whole text.
function findFormat(text: string, context: Context, offset: number, index: FormatIndex, budget: Budget): FoundFormat | null {
  const scan = contextScan(context, index, budget);
  if (scan.lastRelevant < offset) return null;
  const last = context.format;
  if (last && last.at <= offset && last.quietUntil >= offset && (offset === last.at || quietBoundary(context.base, offset, index))) {
    return last.result && moved(last.result, -offset, text);
  }
  let result: FoundFormat | null | undefined;
  for (let window = FIRST_WINDOW; result === undefined && window < text.length; window *= 4) {
    const cut = neutralCut(text, window, index, budget);
    if (cut > 0) result = fromPrefix(text, cut, scan, offset, index, budget);
  }
  const found = result === undefined ? (fromPrefix(text, text.length, scan, offset, index, budget, true) ?? null) : result;
  // Text up to the next delimiter, backtick or backslash can be consumed without changing the answer.
  let quietUntil = offset;
  const base = context.base;
  const limit = found ? offset + found.startIndex : base.length;
  while (quietUntil < limit && !isRelevant(index, base[quietUntil]) && base[quietUntil] !== '\\') quietUntil += 1;
  budget.charge(quietUntil - offset);
  context.format = { at: offset, result: found && moved(found, offset, base), quietUntil };
  return found;
}

// A delimiter run's flanking reads the character before it; at a part's start that is none, which reads like
// whitespace. So a part may start on a delimiter only after whitespace.
function quietBoundary(base: string, offset: number, index: FormatIndex): boolean {
  return !index.delimiterChars.has(base[offset]) || /\s/.test(base[offset - 1]);
}

// `found` with its indices shifted by `shift`, as a match on `input`.
function moved(found: FoundFormat, shift: number, input: string): FoundFormat {
  const startIndex = found.startIndex + shift;
  const endIndex = found.endIndex + shift;
  const match = [input.slice(startIndex, endIndex), found.match[1], found.match[2]] as RegExpMatchArray;
  match.index = startIndex;
  match.input = input;
  return { ...found, startIndex, endIndex, match };
}

// The first cut at or after `window` whose previous character is no delimiter, backtick or backslash, so no run
// and no escape straddles it; 0 when there is none within another window.
function neutralCut(text: string, window: number, index: FormatIndex, budget: Budget): number {
  const end = Math.min(text.length, window * 2);
  for (let cut = window; cut < end; cut += 1) {
    const char = text[cut - 1];
    if (!isRelevant(index, char) && char !== '\\') {
      budget.charge((cut - window) + 1);
      return cut;
    }
  }
  budget.charge(end - window);
  return 0;
}

// Lexical's search on text.slice(0, cut). With `whole` it is the answer; otherwise it is the whole text's answer
// only when the rest cannot change it, else undefined. The rest can only add code spans from runs after the cut (or
// pair a run before the cut that found no closer), and emphasis from closers after the cut, which pair with
// openers still open at the cut or after it.
function fromPrefix(
  text: string,
  cut: number,
  scan: ContextScan,
  offset: number,
  index: FormatIndex,
  budget: Budget,
  whole = false,
): FoundFormat | null | undefined {
  const prefix = cut === text.length ? text : text.slice(0, cut);
  budget.spend(cut);
  const { spans, unclosed } = index.code ? scanCodeSpans(prefix, budget) : { spans: [], unclosed: false };
  const delimiters = scanDelimiters(prefix, index, spans);
  const emphasis = delimiters.length > 0 ? processEmphasis(prefix, delimiters, index, budget) : null;
  const code = spans[0];
  if (!whole) {
    if (unclosed) return undefined;
    let firstOpen = Infinity;
    for (const d of delimiters) if (d.active && d.canOpen && d.length > 0 && d.index < firstOpen) firstOpen = d.index;
    if (code) {
      if (firstOpen <= (emphasis ? emphasis.startIndex : code.startIndex)) return undefined;
    } else {
      if (!emphasis || firstOpen <= emphasis.startIndex) return undefined;
      // No backtick run before the cut can open a span, so the whole text has one only if a run after it does.
      if (index.code && scan.lastSpanOpener >= offset + cut) return undefined;
    }
  }
  return outermost(text, code, emphasis, index);
}

function outermost(text: string, code: Span | undefined, emphasis: Emphasis | null, index: FormatIndex): FoundFormat | null {
  const codeMatch = code ? { content: code.content, endIndex: code.endIndex, startIndex: code.startIndex, tag: '`' } : null;
  let resultMatch: Emphasis | null = null;
  let resultTransformer: TextFormatTransformer | undefined;
  if (codeMatch && emphasis) {
    if (emphasis.startIndex <= codeMatch.startIndex && emphasis.endIndex >= codeMatch.endIndex) {
      resultMatch = emphasis;
      resultTransformer = index.byTag[emphasis.tag];
    } else {
      resultMatch = codeMatch;
      resultTransformer = index.code;
    }
  } else if (codeMatch) {
    resultMatch = codeMatch;
    resultTransformer = index.code;
  } else if (emphasis) {
    resultMatch = emphasis;
    resultTransformer = index.byTag[emphasis.tag];
  }
  if (!resultMatch || !resultTransformer) return null;
  const match = [text.slice(resultMatch.startIndex, resultMatch.endIndex), resultMatch.tag, resultMatch.content] as RegExpMatchArray;
  match.index = resultMatch.startIndex;
  match.input = text;
  return {
    endIndex: resultMatch.endIndex,
    isCodeSpan: resultTransformer === index.code,
    match,
    startIndex: resultMatch.startIndex,
    transformer: resultTransformer,
  };
}

function contextScan(context: Context, index: FormatIndex, budget: Budget): ContextScan {
  if (context.scan) return context.scan;
  const base = context.base;
  budget.spend(base.length / NATIVE);
  let lastRelevant = base.length - 1;
  while (lastRelevant >= 0 && !isRelevant(index, base[lastRelevant])) lastRelevant -= 1;
  let lastSpanOpener = -1;
  if (index.code) {
    const runs = backtickRuns(base);
    const later = new Set<number>();
    for (let r = runs.length - 1; r >= 0; r -= 1) {
      const run = runs[r];
      if (later.has(run.length) && !isEscaped(base, run.index)) {
        lastSpanOpener = run.index;
        break;
      }
      later.add(run.length);
    }
  }
  context.scan = { lastRelevant, lastSpanOpener };
  return context.scan;
}

function isEscaped(text: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) count += 1;
  return count % 2 === 1;
}

function backtickRuns(text: string): { index: number; length: number }[] {
  const runs: { index: number; length: number }[] = [];
  for (let i = text.indexOf('`'); i >= 0; i = text.indexOf('`', i)) {
    let length = 1;
    while (i + length < text.length && text[i + length] === '`') length += 1;
    runs.push({ index: i, length });
    i += length;
  }
  return runs;
}

// Lexical's scanCodeSpans, each opener's closer found in one pass; also says whether an opener found no closer.
function scanCodeSpans(text: string, budget: Budget): { spans: Span[]; unclosed: boolean } {
  const runs = backtickRuns(text);
  budget.spend(runs.length);
  const closer = new Int32Array(runs.length);
  const next = new Map<number, number>();
  for (let r = runs.length - 1; r >= 0; r -= 1) {
    closer[r] = next.get(runs[r].length) ?? -1;
    next.set(runs[r].length, r);
  }
  const spans: Span[] = [];
  let unclosed = false;
  let openIdx = 0;
  while (openIdx < runs.length) {
    const opener = runs[openIdx];
    if (isEscaped(text, opener.index)) {
      openIdx += 1;
      continue;
    }
    const closeIdx = closer[openIdx];
    if (closeIdx === -1) {
      unclosed = true;
      openIdx += 1;
      continue;
    }
    const close = runs[closeIdx];
    let content = text.slice(opener.index + opener.length, close.index);
    if (content.length >= 2 && content.startsWith(' ') && content.endsWith(' ') && /[^ ]/.test(content)) content = content.slice(1, -1);
    spans.push({ content, endIndex: close.index + close.length, startIndex: opener.index });
    openIdx = closeIdx + 1;
  }
  return { spans, unclosed };
}

const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~]/;
const WHITESPACE = /\s/;

// Lexical's scanDelimiters; the excluded ranges (code spans, in order) are walked with the scan.
function scanDelimiters(text: string, index: FormatIndex, spans: Span[]): Delimiter[] {
  const delimiters: Delimiter[] = [];
  let range = 0;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (!index.delimiterChars.has(char) || isEscaped(text, i)) {
      i += 1;
      continue;
    }
    while (range < spans.length && spans[range].endIndex <= i) range += 1;
    if (range < spans.length && spans[range].startIndex <= i) {
      i += 1;
      continue;
    }
    let length = 1;
    while (i + length < text.length && text[i + length] === char) length += 1;
    const canOpen = canEmphasis(char, text, i, length, true);
    const canClose = canEmphasis(char, text, i, length, false);
    if (canOpen || canClose) delimiters.push({ active: true, canClose, canOpen, char, index: i, length });
    i += length;
  }
  return delimiters;
}

// Lexical's processEmphasis.
function processEmphasis(text: string, delimiters: Delimiter[], index: FormatIndex, budget: Budget): Emphasis | null {
  const openersBottom: Record<string, number> = {};
  let currentPos = 0;
  let result: Emphasis | null = null;
  while (currentPos < delimiters.length) {
    const closer = delimiters[currentPos];
    if (!closer.active || !closer.canClose || closer.length === 0) {
      currentPos += 1;
      continue;
    }
    const bottomKey = `${closer.char}${closer.canOpen}${closer.length % 3}`;
    const bottom = openersBottom[bottomKey] ?? -1;
    let foundOpener = false;
    for (let openIdx = currentPos - 1; openIdx > bottom; openIdx -= 1) {
      budget.spend(1);
      const opener = delimiters[openIdx];
      if (!opener.active || !opener.canOpen || opener.length === 0 || opener.char !== closer.char) continue;
      if (opener.canClose || closer.canOpen) {
        const sum = opener.length + closer.length;
        if (sum % 3 === 0 && opener.length % 3 !== 0 && closer.length % 3 !== 0) continue;
      }
      const maxLen = Math.min(opener.length, closer.length);
      const matchedTag = (index.tagsByChar.get(opener.char) ?? []).find((tag) => tag.length <= maxLen);
      if (!matchedTag) continue;
      foundOpener = true;
      const matchLen = matchedTag.length;
      const match = {
        content: text.slice(opener.index + opener.length, closer.index),
        endIndex: closer.index + matchLen,
        startIndex: opener.index + (opener.length - matchLen),
        tag: matchedTag,
      };
      if (!result || match.startIndex < result.startIndex || (match.startIndex === result.startIndex && match.endIndex > result.endIndex)) {
        result = match;
      }
      budget.spend(currentPos - openIdx);
      for (let j = openIdx + 1; j < currentPos; j += 1) delimiters[j].active = false;
      opener.length -= matchLen;
      closer.length -= matchLen;
      opener.active = opener.length > 0;
      if (closer.length > 0) {
        closer.index += matchLen;
      } else {
        closer.active = false;
        currentPos += 1;
      }
      break;
    }
    if (!foundOpener) {
      openersBottom[bottomKey] = currentPos - 1;
      if (!closer.canOpen) closer.active = false;
      currentPos += 1;
    }
  }
  return result;
}

function canEmphasis(char: string, text: string, index: number, length: number, isOpen: boolean): boolean {
  if (!isFlanking(text, index, length, isOpen)) return false;
  if (char === '*') return true;
  if (char === '_') {
    if (!isFlanking(text, index, length, !isOpen)) return true;
    const adjacentChar = isOpen ? text[index - 1] : text[index + length];
    return adjacentChar !== undefined && PUNCTUATION.test(adjacentChar);
  }
  return true;
}

function isFlanking(text: string, index: number, length: number, isLeft: boolean): boolean {
  const charBefore = text[index - 1];
  const charAfter = text[index + length];
  const [primary, secondary] = isLeft ? [charAfter, charBefore] : [charBefore, charAfter];
  if (primary === undefined || WHITESPACE.test(primary)) return false;
  if (!PUNCTUATION.test(primary)) return true;
  return secondary === undefined || WHITESPACE.test(secondary) || PUNCTUATION.test(secondary);
}
