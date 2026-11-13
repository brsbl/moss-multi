// ported-from: packages/desktop/src/common/markdown-layers.ts @ 762abb777
import jsYaml from 'js-yaml';
import { extractLeadingH1 } from './markdown-utils';

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function normalizeFrontmatterDates(value: unknown): unknown {
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeFrontmatterDates(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    normalized[key] = normalizeFrontmatterDates(entry);
  }
  return normalized;
}

// moss-multi seam: frontmatter-aliases (A§10.4): YAML aliases share one parsed node, so a few bytes can name an
// exponential or cyclic tree, or many copies of one long string (js-yaml even joins aliases into a string inside load
// when a flow sequence is a key). The load counts what each alias names as it reads it, and the result is walked once
// more, each node 1 and each string or key its length: past 65,536 plus 4 per character of the YAML, or on a cycle,
// the frontmatter is refused (packages/core/src/frontmatter.ts holds the same bound).
export const FRONTMATTER_EXPANSION_ERROR = 'Frontmatter expands past its budget';

function spendExpansion(value: unknown, budget: { left: number }, refuseCycles: boolean): void {
  const path = new Set<object>();
  const stack: { value: unknown; leave?: boolean }[] = [{ value }];
  while (stack.length > 0) {
    const { value: next, leave } = stack.pop()!;
    if (leave) {
      path.delete(next as object);
      continue;
    }
    budget.left -= typeof next === 'string' ? 1 + next.length : 1;
    if (budget.left < 0) throw new Error(FRONTMATTER_EXPANSION_ERROR);
    if (!next || typeof next !== 'object' || next instanceof Date) continue;
    if (path.has(next)) {
      if (refuseCycles) throw new Error(FRONTMATTER_EXPANSION_ERROR);
      continue;
    }
    path.add(next);
    stack.push({ value: next, leave: true });
    for (const [key, entry] of Object.entries(next)) {
      budget.left -= key.length;
      stack.push({ value: entry });
    }
  }
}

function loadWithinBudget(yaml: string): unknown {
  const aliases = { left: 65_536 + 4 * yaml.length };
  const parsed = jsYaml.load(yaml, {
    // An alias closes with no kind of its own and the node it names as its result.
    listener: (event, state) => {
      if (event === 'close' && (state.kind as string | null) === null && state.result !== null) spendExpansion(state.result, aliases, false);
    },
  });
  spendExpansion(parsed, { left: 65_536 + 4 * yaml.length }, true);
  return parsed;
}

export interface FrontmatterSplitResult {
  data: Record<string, unknown> | null;
  body: string;
  hasFrontmatter: boolean;
  rawYaml?: string;
  error?: string;
}

export function splitFrontmatter(raw: string): FrontmatterSplitResult {
  const match = FRONTMATTER_REGEX.exec(raw);
  if (!match) {
    return { data: null, body: raw, hasFrontmatter: false };
  }

  const rawYaml = match[1];
  const body = raw.slice(match[0].length);

  try {
    const parsed = loadWithinBudget(rawYaml);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        data: normalizeFrontmatterDates(parsed) as Record<string, unknown>,
        body,
        hasFrontmatter: true,
        rawYaml
      };
    }
    return {
      data: null,
      body,
      hasFrontmatter: true,
      rawYaml,
      error: 'Frontmatter must be a YAML mapping'
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Invalid YAML';
    return { data: null, body, hasFrontmatter: true, rawYaml, error: message };
  }
}

export function joinFrontmatter(body: string, data: Record<string, unknown> | null): string {
  if (!data || Object.keys(data).length === 0) {
    return body;
  }

  const yaml = jsYaml
    .dump(data, {
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
      quotingType: '"'
    })
    .trimEnd();

  return `---\n${yaml}\n---\n${body}`;
}

export function hasFrontmatterPrefix(raw: string): boolean {
  return raw.trimStart().startsWith('---');
}

// ---------------------------------------------------------------------------
// Comment footer
// ---------------------------------------------------------------------------

const FOOTER_MARKER = '<!--moss:comments\n';
const FOOTER_CLOSE = '\n-->';

export const LEGACY_COMMENT_OPEN_MARKER = /\{%c:\s*([A-Za-z0-9_,\-\s]+?)\s*%\}/;
export const LEGACY_COMMENT_CLOSE_MARKER = /\{%\/c%\}/;
export const MODERN_COMMENT_OPEN_MARKER = /%%m:\s*([A-Za-z0-9_,\-\s]+?)\s*:start%%/;
export const MODERN_COMMENT_CLOSE_MARKER = /%%m:\s*([A-Za-z0-9_,\-\s]+?)\s*:end%%/;

export interface CommentMetadata {
  text: string;
  createdAt: number;
  updatedAt: number;
  source?: 'user' | 'agent' | 'external';
  /** Id of the root comment this is a reply to. Replies are sidecar-only. */
  parentId?: string;
  imageUrl?: string;
  imageUrls?: string[];
  resolvedAt?: number;
  resolvedBy?: 'user' | 'agent' | 'external';
}

export type CommentMetadataMap = Record<string, CommentMetadata>;
export type CommentSyntax = 'none' | 'legacy' | 'modern' | 'mixed';

export interface ParsedCommentFooter {
  strippedContent: string;
  metadata: CommentMetadataMap;
}

export function coerceCommentMetadataMap(value: unknown): CommentMetadataMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const metadata: CommentMetadataMap = {};

  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }

    const raw = entry as Record<string, unknown>;
    if (
      typeof raw.text !== 'string' ||
      typeof raw.createdAt !== 'number' ||
      !Number.isFinite(raw.createdAt) ||
      typeof raw.updatedAt !== 'number' ||
      !Number.isFinite(raw.updatedAt)
    ) {
      continue;
    }

    const imageUrls = Array.isArray(raw.imageUrls)
      ? raw.imageUrls.filter((item): item is string => typeof item === 'string')
      : undefined;
    const resolvedBy =
      raw.resolvedBy === 'agent'
        ? 'agent'
        : raw.resolvedBy === 'user'
          ? 'user'
          : raw.resolvedBy === 'external'
            ? 'external'
            : undefined;

    metadata[id] = {
      text: raw.text,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      source:
        raw.source === 'agent'
          ? 'agent'
          : raw.source === 'user'
            ? 'user'
            : raw.source === 'external'
              ? 'external'
              : undefined,
      ...(typeof raw.parentId === 'string' && raw.parentId.length > 0 ? { parentId: raw.parentId } : {}),
      ...(typeof raw.imageUrl === 'string' ? { imageUrl: raw.imageUrl } : {}),
      ...(imageUrls && imageUrls.length > 0 ? { imageUrls } : {}),
      ...(typeof raw.resolvedAt === 'number' && Number.isFinite(raw.resolvedAt) ? { resolvedAt: raw.resolvedAt } : {}),
      ...(resolvedBy ? { resolvedBy } : {})
    };
  }

  return metadata;
}

export function parseCommentMetadataJson(jsonText: string): CommentMetadataMap {
  try {
    return coerceCommentMetadataMap(JSON.parse(jsonText));
  } catch {
    return {};
  }
}

export function parseStrictCommentMetadataJson(jsonText: string): CommentMetadataMap {
  const parsed = JSON.parse(jsonText) as unknown;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid comment metadata: expected an object.');
  }

  const metadata: CommentMetadataMap = {};

  for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!id) {
      throw new Error('Invalid comment metadata: comment id cannot be empty.');
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Invalid comment metadata for "${id}": expected an object.`);
    }

    const raw = entry as Record<string, unknown>;
    if (
      typeof raw.text !== 'string' ||
      typeof raw.createdAt !== 'number' ||
      !Number.isFinite(raw.createdAt) ||
      typeof raw.updatedAt !== 'number' ||
      !Number.isFinite(raw.updatedAt)
    ) {
      throw new Error(`Invalid comment metadata for "${id}": missing text or timestamps.`);
    }

    if (
      raw.source !== undefined &&
      raw.source !== 'user' &&
      raw.source !== 'agent' &&
      raw.source !== 'external'
    ) {
      throw new Error(`Invalid comment metadata for "${id}": source is invalid.`);
    }

    if (raw.parentId !== undefined && (typeof raw.parentId !== 'string' || raw.parentId.length === 0)) {
      throw new Error(`Invalid comment metadata for "${id}": parentId is invalid.`);
    }

    if (raw.imageUrl !== undefined && typeof raw.imageUrl !== 'string') {
      throw new Error(`Invalid comment metadata for "${id}": imageUrl is invalid.`);
    }

    if (
      raw.imageUrls !== undefined &&
      (!Array.isArray(raw.imageUrls) || raw.imageUrls.some((item) => typeof item !== 'string'))
    ) {
      throw new Error(`Invalid comment metadata for "${id}": imageUrls is invalid.`);
    }

    if (
      raw.resolvedAt !== undefined &&
      (typeof raw.resolvedAt !== 'number' || !Number.isFinite(raw.resolvedAt))
    ) {
      throw new Error(`Invalid comment metadata for "${id}": resolvedAt is invalid.`);
    }

    if (
      raw.resolvedBy !== undefined &&
      raw.resolvedBy !== 'user' &&
      raw.resolvedBy !== 'agent' &&
      raw.resolvedBy !== 'external'
    ) {
      throw new Error(`Invalid comment metadata for "${id}": resolvedBy is invalid.`);
    }

    metadata[id] = {
      text: raw.text,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      ...(raw.source ? { source: raw.source as CommentMetadata['source'] } : {}),
      ...(typeof raw.parentId === 'string' ? { parentId: raw.parentId } : {}),
      ...(typeof raw.imageUrl === 'string' ? { imageUrl: raw.imageUrl } : {}),
      ...(Array.isArray(raw.imageUrls) && raw.imageUrls.length > 0
        ? { imageUrls: raw.imageUrls as string[] }
        : {}),
      ...(typeof raw.resolvedAt === 'number' ? { resolvedAt: raw.resolvedAt } : {}),
      ...(raw.resolvedBy ? { resolvedBy: raw.resolvedBy as CommentMetadata['resolvedBy'] } : {})
    };
  }

  return metadata;
}

export function serializeCommentMetadata(metadata: CommentMetadataMap): string {
  const normalized = coerceCommentMetadataMap(metadata);
  const sortedEntries = Object.keys(normalized)
    .sort()
    .map((id) => [id, normalized[id]] as const);
  return JSON.stringify(Object.fromEntries(sortedEntries));
}

export function buildCommentMetadataSignature(metadata: CommentMetadataMap): string {
  return serializeCommentMetadata(metadata);
}

export function hasLegacyCommentFooter(markdown: string): boolean {
  if (!markdown.includes(FOOTER_MARKER)) {
    return false;
  }
  return parseCommentFooter(markdown).strippedContent !== markdown;
}

export function containsCommentAnchors(markdown: string): boolean {
  return LEGACY_COMMENT_OPEN_MARKER.test(markdown) || MODERN_COMMENT_OPEN_MARKER.test(markdown);
}

const collectMarkerIds = (value: string, pattern: RegExp, result: Set<string>): void => {
  const re = new RegExp(pattern.source, pattern.flags + 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    for (const id of match[1].split(',').map((entry) => entry.trim()).filter(Boolean)) {
      result.add(id);
    }
  }
};

export function extractCommentAnchorIds(markdown: string): Set<string> {
  const result = new Set<string>();
  collectMarkerIds(markdown, LEGACY_COMMENT_OPEN_MARKER, result);
  collectMarkerIds(markdown, MODERN_COMMENT_OPEN_MARKER, result);
  return result;
}

/**
 * Given the set of root comment ids anchored in the markdown body and the full
 * comment metadata map, return every comment id reachable from an anchored root
 * by walking `parentId` links downward. A reply is reachable only when its whole
 * `parentId` chain leads back to a root whose marker is present in the body.
 *
 * Replies are sidecar-only (no markers), so this is how the persistence layer
 * decides which sidecar rows are live vs. orphaned.
 */
export function collectReachableCommentThreadIds(
  anchorIds: Iterable<string>,
  commentsMap: Record<string, object | undefined>
): Set<string> {
  const anchoredIds = anchorIds instanceof Set ? anchorIds : new Set(anchorIds);
  if (anchoredIds.size === 0) {
    return new Set();
  }

  const rootIds = new Set<string>();
  const childrenByParent = new Map<string, string[]>();
  for (const [id, comment] of Object.entries(commentsMap)) {
    const rawParentId =
      comment && 'parentId' in comment ? (comment as { parentId?: unknown }).parentId : undefined;
    const parentId =
      typeof rawParentId === 'string' && rawParentId.length > 0 ? rawParentId : undefined;
    // A comment is a root when it has no parent, or its parent is missing from
    // the map (a dangling parentId can't keep a reply alive).
    if (!parentId || !Object.prototype.hasOwnProperty.call(commentsMap, parentId)) {
      rootIds.add(id);
      continue;
    }
    if (parentId === id) {
      continue; // self-reference is not a real edge
    }
    const children = childrenByParent.get(parentId);
    if (children) {
      children.push(id);
    } else {
      childrenByParent.set(parentId, [id]);
    }
  }

  const result = new Set<string>();
  const stack: string[] = [];
  for (const rootId of rootIds) {
    if (anchoredIds.has(rootId)) {
      stack.push(rootId);
    }
  }

  while (stack.length > 0) {
    const id = stack.pop()!;
    if (result.has(id)) {
      continue;
    }
    result.add(id);
    for (const childId of childrenByParent.get(id) ?? []) {
      if (!result.has(childId)) {
        stack.push(childId);
      }
    }
  }

  return result;
}

export function stripCommentAnchors(markdown: string): string {
  return markdown
    .replace(new RegExp(LEGACY_COMMENT_OPEN_MARKER.source, 'g'), '')
    .replace(new RegExp(LEGACY_COMMENT_CLOSE_MARKER.source, 'g'), '')
    .replace(new RegExp(MODERN_COMMENT_OPEN_MARKER.source, 'g'), '')
    .replace(new RegExp(MODERN_COMMENT_CLOSE_MARKER.source, 'g'), '');
}

const removeIdsFromMarker = (
  idsText: string,
  idsToRemove: Set<string>
): string[] =>
  idsText
    .split(',')
    .map((entry) => entry.trim())
    .filter((id) => id.length > 0 && !idsToRemove.has(id));

const stripLegacyCommentAnchorsForIds = (markdown: string, idsToRemove: Set<string>): string => {
  const tokenPattern = new RegExp(
    `${LEGACY_COMMENT_OPEN_MARKER.source}|${LEGACY_COMMENT_CLOSE_MARKER.source}`,
    'g'
  );
  const keepCloseStack: boolean[] = [];
  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(markdown)) !== null) {
    result += markdown.slice(lastIndex, match.index);
    const idsText = match[1];
    if (typeof idsText === 'string') {
      const remainingIds = removeIdsFromMarker(idsText, idsToRemove);
      keepCloseStack.push(remainingIds.length > 0);
      if (remainingIds.length > 0) {
        result += `{%c:${remainingIds.join(',')}%}`;
      }
    } else {
      const keepClose = keepCloseStack.length > 0 ? keepCloseStack.pop()! : true;
      if (keepClose) {
        result += match[0];
      }
    }
    lastIndex = tokenPattern.lastIndex;
  }

  return result + markdown.slice(lastIndex);
};

export function stripCommentAnchorsForIds(markdown: string, commentIds: Iterable<string>): string {
  const idsToRemove = new Set([...commentIds].filter((id) => id.length > 0));
  if (idsToRemove.size === 0) {
    return markdown;
  }

  return stripLegacyCommentAnchorsForIds(markdown, idsToRemove)
    .replace(new RegExp(MODERN_COMMENT_OPEN_MARKER.source, 'g'), (_match, idsText: string) => {
      const remainingIds = removeIdsFromMarker(idsText, idsToRemove);
      return remainingIds.length > 0 ? `%%m:${remainingIds.join(',')}:start%%` : '';
    })
    .replace(new RegExp(MODERN_COMMENT_CLOSE_MARKER.source, 'g'), (_match, idsText: string) => {
      const remainingIds = removeIdsFromMarker(idsText, idsToRemove);
      return remainingIds.length > 0 ? `%%m:${remainingIds.join(',')}:end%%` : '';
    });
}

export function detectCommentSyntax(markdown: string): CommentSyntax {
  const hasLegacy = LEGACY_COMMENT_OPEN_MARKER.test(markdown);
  const hasModern = MODERN_COMMENT_OPEN_MARKER.test(markdown);

  if (hasLegacy && hasModern) {
    return 'mixed';
  }
  if (hasLegacy) {
    return 'legacy';
  }
  if (hasModern) {
    return 'modern';
  }
  return 'none';
}

export function parseCommentFooter(markdown: string): ParsedCommentFooter {
  const markerIndex = markdown.lastIndexOf(FOOTER_MARKER);
  if (markerIndex === -1) {
    return { strippedContent: markdown, metadata: {} };
  }

  const closeIndex = markdown.indexOf(FOOTER_CLOSE, markerIndex + FOOTER_MARKER.length);
  if (closeIndex === -1) {
    return { strippedContent: markdown, metadata: {} };
  }

  const closeEnd = closeIndex + FOOTER_CLOSE.length;
  if (markdown.slice(closeEnd).trim().length > 0) {
    return { strippedContent: markdown, metadata: {} };
  }

  const strippedStart =
    markerIndex > 0 && markdown.charCodeAt(markerIndex - 1) === 10
      ? markerIndex - 1
      : markerIndex;
  const strippedContent = markdown.slice(0, strippedStart);

  const jsonText = markdown.slice(markerIndex + FOOTER_MARKER.length, closeIndex);
  return { strippedContent, metadata: parseCommentMetadataJson(jsonText) };
}

// ---------------------------------------------------------------------------
// Serialize comment footer
// ---------------------------------------------------------------------------

/**
 * Serializes comment metadata into a footer string.
 * Returns empty string if there are no comments.
 */
export function serializeCommentFooter(metadata: CommentMetadataMap): string {
  const ids = Object.keys(metadata);
  if (ids.length === 0) {
    return '';
  }

  const json = serializeCommentMetadata(metadata);
  return `\n<!--moss:comments\n${json}\n-->`;
}

// ---------------------------------------------------------------------------
// Disassemble / Assemble
// ---------------------------------------------------------------------------

export interface DisassembledNote {
  frontmatter: Record<string, unknown> | null;
  rawYaml?: string;
  /** Body after frontmatter stripping but before H1/comment stripping. Used for raw-block caching. */
  bodyAfterFrontmatter: string;
  h1Title: string | null;
  body: string;
  comments: CommentMetadataMap;
}

/**
 * Split raw note markdown into its constituent layers.
 * Order: strip frontmatter → strip comment footer → extract H1.
 * Returns raw H1 (may contain wiki-link syntax) — callers sanitize as needed.
 */
export function disassembleNote(raw: string): DisassembledNote {
  const fm = splitFrontmatter(raw);
  const { strippedContent, metadata } = hasLegacyCommentFooter(fm.body)
    ? parseCommentFooter(fm.body)
    : { strippedContent: fm.body, metadata: {} as CommentMetadataMap };
  const { h1Title, body } = extractLeadingH1(strippedContent);
  return { frontmatter: fm.data, rawYaml: fm.rawYaml, bodyAfterFrontmatter: fm.body, h1Title, body, comments: metadata };
}

/**
 * Reassemble note layers into raw markdown for disk persistence.
 * Inverse of disassembleNote.
 *
 * Comment metadata is persisted in a sidecar file (comments.json), not in the
 * markdown body. Set `includeLegacyCommentFooter: true` only when migrating
 * notes that still use the inline `<!--moss:comments-->` footer format.
 */
export function assembleNote(layers: {
  frontmatter?: Record<string, unknown> | null;
  rawFrontmatterBlock?: string | null;
  h1Title?: string | null;
  body: string;
  comments?: CommentMetadataMap;
  includeLegacyCommentFooter?: boolean;
}): string {
  let md = layers.h1Title ? `# ${layers.h1Title}\n\n${layers.body}` : layers.body;
  if (layers.includeLegacyCommentFooter && layers.comments && Object.keys(layers.comments).length > 0) {
    md += serializeCommentFooter(layers.comments);
  }
  if (layers.rawFrontmatterBlock) {
    md = `${layers.rawFrontmatterBlock}${md}`;
  } else {
    md = joinFrontmatter(md, layers.frontmatter ?? null);
  }
  return md;
}

const stableStringifyUnknown = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyUnknown(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringifyUnknown(record[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
};

const buildFrontmatterSignature = (data: Record<string, unknown> | null): string | null => {
  if (!data) {
    return null;
  }
  return stableStringifyUnknown(data);
};

const buildFrontmatterLayerSignature = (layers: Pick<DisassembledNote, 'frontmatter' | 'rawYaml'>): string | null => {
  if (layers.frontmatter || layers.rawYaml === undefined) {
    return buildFrontmatterSignature(layers.frontmatter);
  }
  return `raw:${layers.rawYaml}`;
};

const extractRawFrontmatterBlock = (rawMarkdown: string): string | null => {
  const splitResult = splitFrontmatter(rawMarkdown);
  if (!splitResult.hasFrontmatter) {
    return null;
  }
  const rawBlockLength = rawMarkdown.length - splitResult.body.length;
  if (rawBlockLength <= 0) {
    return null;
  }
  const rawBlock = rawMarkdown.slice(0, rawBlockLength);
  return rawBlock.startsWith('---') ? rawBlock : null;
};

export interface RebasedNonBodySave {
  content: string;
  commentMetadata: CommentMetadataMap;
  rebased: boolean;
}

export interface RebasedActiveUserSave {
  content: string;
  rebased: boolean;
}

/**
 * Rebase a dirty active-editor save onto the latest disk layers. The user's
 * body always wins, while a title or frontmatter layer that the user did not
 * change is taken from the latest disk content.
 */
export function rebaseActiveUserSaveOnLatestDisk(input: {
  pendingContent: string;
  previousDiskContent?: string;
  latestDiskContent: string;
}): RebasedActiveUserSave {
  if (input.previousDiskContent === undefined) {
    return { content: input.pendingContent, rebased: false };
  }

  const pending = disassembleNote(input.pendingContent);
  const baseline = disassembleNote(input.previousDiskContent);
  const latest = disassembleNote(input.latestDiskContent);
  const titleChangedLocally = pending.h1Title !== baseline.h1Title;
  const frontmatterChangedLocally =
    buildFrontmatterLayerSignature(pending) !== buildFrontmatterLayerSignature(baseline);
  const frontmatterSource = frontmatterChangedLocally ? pending : latest;
  const rawFrontmatterBlock = frontmatterChangedLocally
    ? extractRawFrontmatterBlock(input.pendingContent)
    : extractRawFrontmatterBlock(input.latestDiskContent);
  const content = assembleNote({
    frontmatter: frontmatterSource.frontmatter,
    rawFrontmatterBlock,
    h1Title: titleChangedLocally ? pending.h1Title : latest.h1Title,
    body: pending.body
  });

  return { content, rebased: content !== input.pendingContent };
}

/**
 * Rebase a stale local save onto newer disk content when the local editor body
 * did not change. This protects agent-written body content from being replaced
 * by title/frontmatter-only or sidecar-only comment saves from the active editor.
 */
export function rebaseNonBodySaveOnLatestDisk(input: {
  pendingContent: string;
  localBaselineContent?: string;
  previousDiskContent?: string;
  latestDiskContent: string;
  pendingCommentMetadata?: CommentMetadataMap;
  baselineCommentMetadata?: CommentMetadataMap;
  latestCommentMetadata?: CommentMetadataMap;
}): RebasedNonBodySave {
  const pendingCommentMetadata = input.pendingCommentMetadata ?? {};
  const baselineContent = input.localBaselineContent ?? input.previousDiskContent;
  if (!baselineContent) {
    return { content: input.pendingContent, commentMetadata: pendingCommentMetadata, rebased: false };
  }

  const pending = disassembleNote(input.pendingContent);
  const baseline = disassembleNote(baselineContent);
  if (pending.body !== baseline.body) {
    return { content: input.pendingContent, commentMetadata: pendingCommentMetadata, rebased: false };
  }

  const latest = disassembleNote(input.latestDiskContent);
  const baselineCommentMetadata = input.baselineCommentMetadata ?? {};
  const latestCommentMetadata = input.latestCommentMetadata ?? {};
  const titleChangedLocally = pending.h1Title !== baseline.h1Title;
  const frontmatterChangedLocally =
    buildFrontmatterLayerSignature(pending) !== buildFrontmatterLayerSignature(baseline);
  const commentsChangedLocally =
    buildCommentMetadataSignature(pendingCommentMetadata) !== buildCommentMetadataSignature(baselineCommentMetadata);

  const frontmatterSource = frontmatterChangedLocally ? pending : latest;
  const rawFrontmatterBlock = frontmatterChangedLocally
    ? extractRawFrontmatterBlock(input.pendingContent)
    : extractRawFrontmatterBlock(input.latestDiskContent);

  const content = assembleNote({
    frontmatter: frontmatterSource.frontmatter,
    rawFrontmatterBlock,
    h1Title: titleChangedLocally ? pending.h1Title : latest.h1Title,
    body: latest.body
  });
  const commentMetadata = commentsChangedLocally ? pendingCommentMetadata : latestCommentMetadata;
  const rebased =
    content !== input.pendingContent ||
    buildCommentMetadataSignature(commentMetadata) !== buildCommentMetadataSignature(pendingCommentMetadata);

  return { content, commentMetadata, rebased };
}

export interface CommentMetadataMergeResult {
  /** Three-way merged metadata. */
  merged: CommentMetadataMap;
  /**
   * Comment IDs that could not be auto-merged. Kept for defensive callers; the
   * current merge preserves comment sidecar churn without producing conflicts.
   */
  conflictIds: string[];
}

const buildCommentEntrySignature = (metadata: CommentMetadataMap, id: string): string | null =>
  Object.prototype.hasOwnProperty.call(metadata, id)
    ? serializeCommentMetadata({ [id]: metadata[id] })
    : null;

const commentFieldSignature = (value: unknown): string => JSON.stringify(value ?? null);

const commentFieldChanged = <T>(
  base: CommentMetadata | undefined,
  entry: CommentMetadata,
  read: (entry: CommentMetadata | undefined) => T
): boolean => commentFieldSignature(read(entry)) !== commentFieldSignature(read(base));

const chooseCommentField = <T>(
  base: CommentMetadata | undefined,
  local: CommentMetadata,
  latest: CommentMetadata,
  read: (entry: CommentMetadata | undefined) => T
): T => {
  if (commentFieldChanged(base, local, read)) {
    return read(local);
  }
  if (commentFieldChanged(base, latest, read)) {
    return read(latest);
  }
  return read(local);
};

const getCommentImageUrls = (entry: CommentMetadata | undefined): string[] => {
  if (!entry) {
    return [];
  }
  if (Array.isArray(entry.imageUrls) && entry.imageUrls.length > 0) {
    return entry.imageUrls.filter((url) => typeof url === 'string' && url.length > 0);
  }
  return typeof entry.imageUrl === 'string' && entry.imageUrl.length > 0 ? [entry.imageUrl] : [];
};

const mergeCommentImageUrls = (
  local: CommentMetadata,
  latest: CommentMetadata
): string[] => {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const url of [...getCommentImageUrls(local), ...getCommentImageUrls(latest)]) {
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
};

const mergeResolvedCommentState = (
  merged: CommentMetadata,
  local: CommentMetadata,
  latest: CommentMetadata
): void => {
  const candidates = [local, latest]
    .filter((entry) => typeof entry.resolvedAt === 'number' && Number.isFinite(entry.resolvedAt))
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
  const resolved = candidates[0];
  if (!resolved) {
    return;
  }
  merged.resolvedAt = resolved.resolvedAt;
  if (resolved.resolvedBy) {
    merged.resolvedBy = resolved.resolvedBy;
  }
};

const hashCommentMetadataId = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const buildPreservedTextReplyId = (
  parentId: string,
  entry: CommentMetadata
): string => `merge-${hashCommentMetadataId(`${parentId}:${serializeCommentMetadata({ preserved: entry })}`)}`;

const buildPreservedTextReply = (
  parentId: string,
  entry: CommentMetadata
): CommentMetadata => {
  const imageUrls = getCommentImageUrls(entry);
  return {
    text: entry.text,
    createdAt: entry.parentId ? entry.createdAt : entry.updatedAt,
    updatedAt: entry.updatedAt,
    ...(entry.source ? { source: entry.source } : {}),
    parentId,
    ...(imageUrls.length > 0 ? { imageUrls } : {}),
    ...(typeof entry.resolvedAt === 'number' ? { resolvedAt: entry.resolvedAt } : {}),
    ...(entry.resolvedBy ? { resolvedBy: entry.resolvedBy } : {})
  };
};

const hasEquivalentPreservedTextReply = (
  metadata: CommentMetadataMap,
  parentId: string,
  entry: CommentMetadata
): boolean => {
  for (const candidate of Object.values(metadata)) {
    if (
      candidate.parentId === parentId &&
      candidate.text === entry.text &&
      candidate.updatedAt === entry.updatedAt &&
      candidate.source === entry.source
    ) {
      return true;
    }
  }
  return false;
};

const preserveDivergedCommentTextAsReply = (
  merged: CommentMetadataMap,
  id: string,
  base: CommentMetadata | undefined,
  local: CommentMetadata | undefined,
  latest: CommentMetadata | undefined,
  sourceMaps: CommentMetadataMap[]
): void => {
  if (!local || !latest || local.text === latest.text) {
    return;
  }

  const localTextChanged = commentFieldChanged(base, local, (entry) => entry?.text ?? '');
  const latestTextChanged = commentFieldChanged(base, latest, (entry) => entry?.text ?? '');
  if (!localTextChanged || !latestTextChanged) {
    return;
  }

  const winner = localTextChanged ? local : latest;
  const loser = winner === local ? latest : local;
  const parentId = loser.parentId ?? winner.parentId ?? id;
  if (
    hasEquivalentPreservedTextReply(merged, parentId, loser) ||
    sourceMaps.some((metadata) => hasEquivalentPreservedTextReply(metadata, parentId, loser))
  ) {
    return;
  }

  const reply = buildPreservedTextReply(parentId, loser);
  let replyId = buildPreservedTextReplyId(parentId, reply);
  let suffix = 2;
  while (
    Object.prototype.hasOwnProperty.call(merged, replyId) ||
    sourceMaps.some((metadata) => Object.prototype.hasOwnProperty.call(metadata, replyId))
  ) {
    replyId = `${buildPreservedTextReplyId(parentId, reply)}-${suffix}`;
    suffix += 1;
  }
  merged[replyId] = reply;
};

const mergeDivergedCommentEntry = (
  base: CommentMetadata | undefined,
  local: CommentMetadata | undefined,
  latest: CommentMetadata | undefined
): CommentMetadata | null => {
  if (!local && !latest) {
    return null;
  }
  if (!local) {
    return latest ?? null;
  }
  if (!latest) {
    return local;
  }

  const localTextChanged = commentFieldChanged(base, local, (entry) => entry?.text ?? '');
  const latestTextChanged = commentFieldChanged(base, latest, (entry) => entry?.text ?? '');
  const textFromLocal = localTextChanged || !latestTextChanged;
  const merged: CommentMetadata = {
    text: textFromLocal ? local.text : latest.text,
    createdAt: base?.createdAt ?? Math.min(local.createdAt, latest.createdAt),
    updatedAt: Math.max(local.updatedAt, latest.updatedAt)
  };

  const source = textFromLocal
    ? local.source
    : chooseCommentField(base, local, latest, (entry) => entry?.source);
  if (source) {
    merged.source = source;
  }

  const parentId = chooseCommentField(base, local, latest, (entry) => entry?.parentId);
  if (parentId) {
    merged.parentId = parentId;
  }

  const imageUrls = mergeCommentImageUrls(local, latest);
  if (imageUrls.length > 0) {
    merged.imageUrls = imageUrls;
  }

  mergeResolvedCommentState(merged, local, latest);
  return merged;
};

/**
 * Three-way merge of comment sidecar metadata between a common `baseline`
 * (last-known disk state), the `local` pending edits, and the `latest` disk
 * state. Non-conflicting changes from both sides are preserved. Same-comment
 * sidecar churn is merged field-by-field: local text/source/parent edits win,
 * divergent latest text is preserved as a reply, image attachments are unioned,
 * and resolved state is carried forward.
 *
 * This guards the conflict-recovery save path: when a save retries against the
 * latest disk sidecar, it must merge external comment changes in rather than
 * overwriting them with stale local metadata.
 */
export function mergeCommentMetadata(
  baseline: CommentMetadataMap,
  local: CommentMetadataMap,
  latest: CommentMetadataMap
): CommentMetadataMergeResult {
  const base = coerceCommentMetadataMap(baseline);
  const localMap = coerceCommentMetadataMap(local);
  const latestMap = coerceCommentMetadataMap(latest);

  const ids = new Set<string>([
    ...Object.keys(base),
    ...Object.keys(localMap),
    ...Object.keys(latestMap)
  ]);

  const merged: CommentMetadataMap = {};
  const conflictIds: string[] = [];

  for (const id of ids) {
    const baseSig = buildCommentEntrySignature(base, id);
    const localSig = buildCommentEntrySignature(localMap, id);
    const latestSig = buildCommentEntrySignature(latestMap, id);

    if (localSig === latestSig) {
      // Both sides agree (including agreeing to delete) — nothing to reconcile.
      if (localSig !== null) merged[id] = localMap[id];
      continue;
    }
    if (localSig === baseSig) {
      // Only the latest disk changed this comment — take the external value.
      if (latestSig !== null) merged[id] = latestMap[id];
      continue;
    }
    if (latestSig === baseSig) {
      // Only the local edit changed this comment — keep the local value.
      if (localSig !== null) merged[id] = localMap[id];
      continue;
    }
    const mergedEntry = mergeDivergedCommentEntry(base[id], localMap[id], latestMap[id]);
    if (mergedEntry) {
      merged[id] = mergedEntry;
      preserveDivergedCommentTextAsReply(merged, id, base[id], localMap[id], latestMap[id], [
        base,
        localMap,
        latestMap
      ]);
    }
  }

  return { merged, conflictIds };
}

/**
 * Identify comment metadata IDs that have no reachable root anchor in `markdown`.
 *
 * A comment is reachable when its root marker is present in the markdown body and
 * its `parentId` chain back to that root is intact. After a non-body rebase — or
 * when the local body wins over an external anchor change — a merged-in comment
 * can end up with no anchor in the final markdown. Persisting it would write
 * orphaned sidecar metadata that no UI can reach. Callers use this to apply an
 * explicit policy: either drop the unreachable rows or refuse the write.
 */
export function findUnreachableCommentMetadata(
  markdown: string,
  metadata: CommentMetadataMap
): string[] {
  const ids = Object.keys(metadata);
  if (ids.length === 0) {
    return [];
  }
  const reachableIds = collectReachableCommentThreadIds(extractCommentAnchorIds(markdown), metadata);
  return ids.filter((id) => !reachableIds.has(id));
}

export function dropUnreachableCommentMetadata(
  markdown: string,
  metadata: CommentMetadataMap
): { metadata: CommentMetadataMap; droppedIds: string[] } {
  const droppedIds = findUnreachableCommentMetadata(markdown, metadata);
  if (droppedIds.length === 0) {
    return { metadata, droppedIds };
  }

  const dropped = new Set(droppedIds);
  const next: CommentMetadataMap = {};
  for (const [id, entry] of Object.entries(metadata)) {
    if (!dropped.has(id)) {
      next[id] = entry;
    }
  }
  return { metadata: next, droppedIds };
}

export function findExternallyChangedUnreachableCommentMetadata(options: {
  markdown: string;
  mergedMetadata: CommentMetadataMap;
  currentMetadata: CommentMetadataMap;
  latestMetadata: CommentMetadataMap;
}): string[] {
  return findUnreachableCommentMetadata(options.markdown, options.mergedMetadata)
    .filter((id) => {
      const latestSig = buildCommentEntrySignature(options.latestMetadata, id);
      if (latestSig === null) {
        return false;
      }
      return latestSig !== buildCommentEntrySignature(options.currentMetadata, id);
    });
}
