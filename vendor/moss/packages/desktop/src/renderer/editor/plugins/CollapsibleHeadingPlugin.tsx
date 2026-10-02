// ported-from: packages/desktop/src/renderer/editor/plugins/CollapsibleHeadingPlugin.tsx @ 762abb777
/**
 * CollapsibleHeadingPlugin
 *
 * Enables H1-H4 headings to be collapsed/expanded via a hover-activated chevron.
 * Collapse state is persisted to meta.json as heading identities ("level:text:ordinal").
 *
 * Tri-state cycle for headings with mixed checked/unchecked checklist items:
 *   expanded → semi-collapsed (hides checked items) → fully-collapsed → expanded
 *
 * Headings without checklists or with only checked/unchecked items use binary toggle.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getNodeByKey,
  $getRoot,
  $getNearestNodeFromDOMNode,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  type LexicalCommand
} from 'lexical';
import { $isHeadingNode, type HeadingNode, type HeadingTagType } from '@lexical/rich-text';
import { $isListNode, $isListItemNode, ListItemNode, ListNode } from '@lexical/list';
import { ChevronRight, Copy, Link2 } from 'lucide-react';
import { useAtomValue, useStore } from 'jotai';
import { noteCollapsedHeadingsAtom, noteEntityAtom } from '@moss/shared';
import { stripWikiLinks } from '../../../common/utils';
import { EDITOR_UPDATE_TAGS } from '../utils/editorUpdateTags';
import {
  buildCopyNoteLinkClipboardData,
  buildMossNoteLinkClipboardHtml,
  buildSameNoteAnchorClipboardData,
  resolveNoteLinkCopiedMessage,
  NOTE_LINK_COPIED_EVENT,
  NOTE_LINK_COPIED_MESSAGE,
  type NoteLinkClipboardData,
  type NoteLinkCopiedEventDetail
} from '../utils/note-link-clipboard';

// ── Types ────────────────────────────────────────────────────────────────────

type CollapseLevel = 'semi' | 'full';

export const REVEAL_COLLAPSED_HEADING_COMMAND: LexicalCommand<{ targetNodeKey: string }> =
  createCommand('REVEAL_COLLAPSED_HEADING_COMMAND');

// ── Heading Helpers ──────────────────────────────────────────────────────────

/** Get numeric level from heading tag (h1 = 1, h2 = 2, h3 = 3, h4 = 4) */
function getHeadingLevel(tag: HeadingTagType): number {
  return parseInt(tag.slice(1), 10);
}

/** Find all sibling node keys between this heading and the next equal/higher heading */
function getCollapsibleContentKeys(headingNode: HeadingNode): string[] {
  const level = getHeadingLevel(headingNode.getTag());
  const contentKeys: string[] = [];
  let sibling = headingNode.getNextSibling();

  while (sibling) {
    if ($isHeadingNode(sibling)) {
      const siblingLevel = getHeadingLevel(sibling.getTag());
      // Stop at equal or higher level heading
      if (siblingLevel <= level) break;
    }
    contentKeys.push(sibling.getKey());
    sibling = sibling.getNextSibling();
  }

  return contentKeys;
}

function getCollapsedHeadingKeysContainingTarget(
  targetNodeKey: string,
  collapsedKeys: Map<string, CollapseLevel>
): string[] {
  const targetNode = $getNodeByKey(targetNodeKey);
  const targetTopLevel = targetNode?.getTopLevelElement();
  if (!targetTopLevel) return [];

  const targetTopLevelKey = targetTopLevel.getKey();
  const containingHeadingKeys: string[] = [];
  for (const headingKey of collapsedKeys.keys()) {
    const headingNode = $getNodeByKey(headingKey);
    if (
      $isHeadingNode(headingNode) &&
      getCollapsibleContentKeys(headingNode).includes(targetTopLevelKey)
    ) {
      containingHeadingKeys.push(headingKey);
    }
  }
  return containingHeadingKeys;
}

/** Check if a heading has collapsible content */
function hasCollapsibleContent(headingNode: HeadingNode): boolean {
  const nextSibling = headingNode.getNextSibling();
  if (!nextSibling) return false;

  // If next sibling is a heading of equal/higher level, nothing to collapse
  if ($isHeadingNode(nextSibling)) {
    const headingLevel = getHeadingLevel(headingNode.getTag());
    const siblingLevel = getHeadingLevel(nextSibling.getTag());
    return siblingLevel > headingLevel;
  }

  return true;
}

// ── Task Detection ───────────────────────────────────────────────────────────

interface TaskInfo {
  hasCompleted: boolean;
  hasUncompleted: boolean;
}

/** Given a wrapper ListItemNode, find the text-bearing ListItem that owns it (previous sibling). */
function getWrapperOwner(wrapper: ListItemNode): ListItemNode | null {
  const prev = wrapper.getPreviousSibling();
  return prev && $isListItemNode(prev) && prev.getChildren().some((c) => !$isListNode(c))
    ? prev
    : null;
}

/**
 * Walk sibling nodes under a heading and detect checked/unchecked checklist items.
 * Must be called inside editor.read().
 */
function getHeadingTaskInfo(headingNode: HeadingNode): TaskInfo {
  const result: TaskInfo = { hasCompleted: false, hasUncompleted: false };
  let sibling = headingNode.getNextSibling();

  while (sibling) {
    // Scoped to immediate content — stop at ANY heading
    if ($isHeadingNode(sibling)) break;

    if ($isListNode(sibling) && sibling.getListType() === 'check') {
      const walkTaskInfo = (listNode: ListNode) => {
        for (const child of listNode.getChildren()) {
          if (!$isListItemNode(child)) continue;
          const children = child.getChildren();
          const isWrapper = children.length > 0 && children.every((n) => $isListNode(n));
          if (isWrapper) {
            const owner = getWrapperOwner(child);
            if (owner && owner.getChecked()) {
              // Owner is checked — still peek into nested lists to detect unchecked children
              for (const nested of children) {
                if ($isListNode(nested)) walkTaskInfo(nested);
              }
              if (result.hasCompleted && result.hasUncompleted) return;
            } else {
              // Unowned or unchecked owner — recurse normally
              for (const nested of children) {
                if ($isListNode(nested)) walkTaskInfo(nested);
              }
            }
            continue;
          }
          if (child.getChecked()) {
            result.hasCompleted = true;
          } else {
            result.hasUncompleted = true;
          }
          if (result.hasCompleted && result.hasUncompleted) return;
        }
      };
      walkTaskInfo(sibling);
      if (result.hasCompleted && result.hasUncompleted) return result;
    }

    sibling = sibling.getNextSibling();
  }

  return result;
}

/**
 * For a semi-collapsed heading, count checked items and collect their DOM elements
 * along with the ListNode elements they belong to.
 */
interface SemiCollapseInfo {
  /** Checked ListItemNode DOM elements to hide, grouped by list node key */
  checkedByList: Map<string, HTMLElement[]>;
  /** Map from list node key → { element, count } */
  listInfo: Map<string, { element: HTMLElement; count: number }>;
}

function getSemiCollapseInfo(
  headingNode: HeadingNode,
  editor: { getElementByKey: (key: string) => HTMLElement | null }
): SemiCollapseInfo {
  const checkedByList = new Map<string, HTMLElement[]>();
  const listInfo = new Map<string, { element: HTMLElement; count: number }>();
  let sibling = headingNode.getNextSibling();

  while (sibling) {
    // Semi-collapse is scoped to IMMEDIATE content — stop at ANY heading.
    // (Full collapse uses hierarchical level check; semi only hides checked
    // items in the lists directly under this heading, not under sub-headings.)
    if ($isHeadingNode(sibling)) break;

    if ($isListNode(sibling) && sibling.getListType() === 'check') {
      const listKey = sibling.getKey();
      const listElement = editor.getElementByKey(listKey);
      const checked: HTMLElement[] = [];
      let totalItems = 0;

      // Walk all nested list items (Lexical nests as ListItem → ListNode → ListItem)
      // Returns whether ALL items in the walked list are checked
      const walk = (listNode: ListNode): boolean => {
        let localTotal = 0;
        let localChecked = 0;

        for (const child of listNode.getChildren()) {
          if ($isListItemNode(child)) {
            const children = child.getChildren();
            const isWrapper = children.length > 0 && children.every((n) => $isListNode(n));
            if (isWrapper) {
              const owner = getWrapperOwner(child);
              const ownerChecked = owner !== null && owner.getChecked() === true;
              let allNestedChecked = true;
              for (const nested of children) {
                if ($isListNode(nested) && !walk(nested)) {
                  allNestedChecked = false;
                }
              }
              if (ownerChecked) {
                totalItems++;
                localTotal++;
                // Only hide the wrapper if all its nested items are checked
                if (allNestedChecked) {
                  const wrapperEl = editor.getElementByKey(child.getKey());
                  if (wrapperEl) checked.push(wrapperEl as HTMLElement);
                  localChecked++;
                }
              } else {
                totalItems++;
                localTotal++;
                // If every item inside the wrapper is checked, hide the wrapper too
                if (allNestedChecked) {
                  const el = editor.getElementByKey(child.getKey());
                  if (el) checked.push(el as HTMLElement);
                  localChecked++;
                }
              }
              continue;
            }
            totalItems++;
            localTotal++;
            if (child.getChecked()) {
              const el = editor.getElementByKey(child.getKey());
              if (el) checked.push(el as HTMLElement);
              localChecked++;
            }
          }
        }

        return localTotal > 0 && localChecked === localTotal;
      };
      walk(sibling);

      // Only show "Completed" if some (but not all) items are checked
      if (listElement && checked.length > 0 && checked.length < totalItems) {
        checkedByList.set(listKey, checked);
        listInfo.set(listKey, { element: listElement as HTMLElement, count: checked.length });
      }
    }

    sibling = sibling.getNextSibling();
  }

  return { checkedByList, listInfo };
}

// ── Persistence ──────────────────────────────────────────────────────────────

function parseIdentity(raw: string): { identity: string; level: CollapseLevel } {
  if (raw.endsWith('|semi')) return { identity: raw.slice(0, -5), level: 'semi' };
  return { identity: raw, level: 'full' };
}

function serializeIdentity(identity: string, level: CollapseLevel): string {
  return level === 'semi' ? `${identity}|semi` : identity;
}

// ── Identity Map ─────────────────────────────────────────────────────────────

/**
 * Build the heading identity string for persistence.
 * Format: "level:text:ordinal" where ordinal disambiguates duplicate level+text combos.
 */
function getHeadingIdentity(headingNode: HeadingNode, ordinalMap: Map<string, number>): string {
  const level = getHeadingLevel(headingNode.getTag());
  const text = headingNode.getTextContent().trim();
  const baseKey = `${level}:${text}`;
  const ordinal = ordinalMap.get(baseKey) ?? 0;
  ordinalMap.set(baseKey, ordinal + 1);
  return `${level}:${text}:${ordinal}`;
}

/**
 * Walk the editor tree and build a bidirectional map between node keys and heading identities.
 * Must be called inside editor.read().
 */
function buildHeadingMaps(): { keyToIdentity: Map<string, string>; identityToKey: Map<string, string> } {
  const keyToIdentity = new Map<string, string>();
  const identityToKey = new Map<string, string>();
  const ordinalMap = new Map<string, number>();

  const root = $getRoot();
  for (const child of root.getChildren()) {
    if ($isHeadingNode(child)) {
      const identity = getHeadingIdentity(child, ordinalMap);
      keyToIdentity.set(child.getKey(), identity);
      identityToKey.set(identity, child.getKey());
    }
  }

  return { keyToIdentity, identityToKey };
}

// ── Toggle Logic ─────────────────────────────────────────────────────────────

function nextCollapseLevel(
  current: CollapseLevel | undefined,
  hasCompletedTasks: boolean,
  hasUncompletedTasks: boolean
): CollapseLevel | undefined {
  // Semi only when there are BOTH completed AND uncompleted tasks
  const canSemiCollapse = hasCompletedTasks && hasUncompletedTasks;
  if (!canSemiCollapse) return current === 'full' ? undefined : 'full';
  switch (current) {
    case undefined: return 'semi';
    case 'semi': return 'full';
    case 'full': return undefined;
  }
}

// ── Components ───────────────────────────────────────────────────────────────

interface HeadingInfo {
  nodeKey: string;
  element: HTMLElement;
  hasContent: boolean;
}

interface ChevronOverlayProps {
  headingElement: HTMLElement;
  scrollContainer: HTMLElement;
  collapseLevel: CollapseLevel | undefined;
  onToggle: () => void;
  onHoverStart: () => void;
  onOpenContextMenu: (event: React.MouseEvent) => void;
}

const CHEVRON_TARGET_SIZE = 32;
const CHEVRON_ICON_CENTER_OFFSET = 12;

/** Pure position math — exported via __test__ for unit testing */
function computeChevronStyle(
  headingRect: DOMRect,
  containerRect: DOMRect,
  scrollLeft: number,
  scrollTop: number,
  headingHeight: number
): { left: number; top: number; width: number; height: number } {
  return {
    left: headingRect.left - containerRect.left + scrollLeft - CHEVRON_ICON_CENTER_OFFSET - CHEVRON_TARGET_SIZE / 2,
    top: headingRect.top - containerRect.top + scrollTop + (headingHeight - CHEVRON_TARGET_SIZE) / 2,
    width: CHEVRON_TARGET_SIZE,
    height: CHEVRON_TARGET_SIZE
  };
}

function ChevronOverlay({
  headingElement,
  scrollContainer,
  collapseLevel,
  onToggle,
  onHoverStart,
  onOpenContextMenu
}: ChevronOverlayProps) {
  const rect = headingElement.getBoundingClientRect();
  const containerRect = scrollContainer.getBoundingClientRect();

  const pos = computeChevronStyle(
    rect,
    containerRect,
    scrollContainer.scrollLeft,
    scrollContainer.scrollTop,
    rect.height
  );

  const style: React.CSSProperties = {
    position: 'absolute',
    left: pos.left,
    top: pos.top,
    width: pos.width,
    height: pos.height,
    zIndex: 40
  };

  // Rotation: expanded → rotate-90, semi → rotate-45, full → rotate-0
  const rotationClass =
    collapseLevel === undefined ? 'rotate-90' :
    collapseLevel === 'semi' ? 'rotate-45' :
    '';

  // Always show chevron when collapsed (either level), hover-only when expanded
  const visibilityClass = 'opacity-70 group-hover:opacity-100';

  const ariaExpanded = collapseLevel === undefined ? true : false;

  return createPortal(
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      onMouseEnter={onHoverStart}
      onMouseMove={onHoverStart}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenContextMenu(e);
      }}
      className="collapsible-heading-chevron group flex items-center justify-center text-ink-muted focus-visible:outline-none"
      style={style}
      aria-label={
        collapseLevel === 'full' ? 'Expand section' :
        collapseLevel === 'semi' ? 'Collapse section fully' :
        'Collapse section'
      }
      aria-expanded={ariaExpanded}
    >
      {/* The button stays an oversized transparent hit target; only this inner
          square paints hover chrome so it never overlaps the heading text. */}
      <span className="flex h-5 w-5 items-center justify-center rounded-md transition-colors group-hover:bg-surface-panel group-hover:text-ink-default group-focus-visible:ring-2 group-focus-visible:ring-accent-brand/30">
        <ChevronRight
          className={`h-3 w-3 flex-shrink-0 transition-transform duration-150 ${rotationClass} ${visibilityClass}`}
          aria-hidden
        />
      </span>
    </button>,
    scrollContainer
  );
}

interface HeadingAnchorContextMenuState {
  isVisible: boolean;
  position: { x: number; y: number };
  nodeKey: string;
  headingText: string;
}

const initialHeadingAnchorContextMenuState: HeadingAnchorContextMenuState = {
  isVisible: false,
  position: { x: 0, y: 0 },
  nodeKey: '',
  headingText: ''
};

const HEADING_ANCHOR_CONTEXT_MENU_LABELS = {
  anchor: 'Copy anchor link',
  note: 'Copy note link'
} as const;

interface HeadingCopyContext {
  noteId: string;
  noteTitle: string;
  folderPath?: string | null;
  filesystemPath?: string | null;
  headingText: string;
}

/**
 * Resolve the clipboard data + toast message for a heading-menu copy action.
 * `anchor` copies a same-note heading anchor; `note` copies a cross-note link
 * to this heading. Both target a heading, so the message is derived from the
 * built wiki link via the shared resolver — keeping the menu's feedback
 * consistent with the top-nav copy button.
 */
function buildHeadingCopyAction(
  kind: 'anchor' | 'note',
  context: HeadingCopyContext
): { data: NoteLinkClipboardData | null; message: string } {
  const data =
    kind === 'anchor'
      ? buildSameNoteAnchorClipboardData({
          noteTitle: context.noteTitle,
          filesystemPath: context.filesystemPath,
          headingText: context.headingText
        })
      : buildCopyNoteLinkClipboardData({
          noteId: context.noteId,
          noteTitle: context.noteTitle,
          folderPath: context.folderPath,
          filesystemPath: context.filesystemPath,
          headingText: context.headingText
        });

  return {
    data,
    message: data
      ? resolveNoteLinkCopiedMessage(data.payload.wikiLink)
      : NOTE_LINK_COPIED_MESSAGE
  };
}

const writeHeadingLinkToClipboard = async (
  data: NoteLinkClipboardData
): Promise<void> => {
  const html = buildMossNoteLinkClipboardHtml(data.payload);
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.write === 'function' &&
    typeof ClipboardItem !== 'undefined'
  ) {
    await navigator.clipboard.write([
      new ClipboardItem({
        // text/plain is what external (non-Moss) apps paste — keep it a plain
        // path. The rich text/html payload preserves the wiki/anchor link for
        // in-Moss paste.
        'text/plain': new Blob([data.plainText], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      }),
    ]);
    return;
  }

  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    await navigator.clipboard.writeText(data.plainText);
  }
};

function HeadingAnchorContextMenu({
  state,
  noteId,
  noteTitle,
  folderPath,
  filesystemPath,
  onClose,
  onCopied
}: {
  state: HeadingAnchorContextMenuState;
  noteId: string;
  noteTitle: string;
  folderPath?: string | null;
  filesystemPath?: string | null;
  onClose: () => void;
  onCopied: (message: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state.isVisible) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const handleScroll = () => onClose();

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    document.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [state.isVisible, onClose]);

  if (!state.isVisible) return null;

  const copyContext: HeadingCopyContext = {
    noteId,
    noteTitle,
    folderPath,
    filesystemPath,
    headingText: state.headingText
  };
  const anchorAction = buildHeadingCopyAction('anchor', copyContext);
  const noteAction = buildHeadingCopyAction('note', copyContext);

  const copyLink = async (data: NoteLinkClipboardData | null, message: string) => {
    if (!data) return;
    try {
      await writeHeadingLinkToClipboard(data);
      onCopied(message);
    } catch (error) {
      console.warn('[CollapsibleHeadingPlugin] Failed to copy heading link:', error);
    } finally {
      onClose();
    }
  };

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50 min-w-48 overflow-hidden rounded-lg border border-border-subtle bg-surface-canvas p-1 text-ink-default shadow-lg animate-in fade-in-0 zoom-in-95"
      style={{
        left: state.position.x,
        top: state.position.y,
        WebkitAppRegion: 'no-drag'
      } as React.CSSProperties}
      role="menu"
    >
      <button
        type="button"
        role="menuitem"
        className="relative flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-left text-micro outline-none transition-colors hover:bg-accent-brand/10 hover:text-accent-brand-pressed"
        onClick={() => void copyLink(anchorAction.data, anchorAction.message)}
      >
        <Copy className="h-3.5 w-3.5 text-ink-muted" aria-hidden />
        <span>{HEADING_ANCHOR_CONTEXT_MENU_LABELS.anchor}</span>
      </button>
      <div className="my-1 h-px bg-border-subtle" />
      <button
        type="button"
        role="menuitem"
        className="relative flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-left text-micro outline-none transition-colors hover:bg-accent-brand/10 hover:text-accent-brand-pressed"
        onClick={() => void copyLink(noteAction.data, noteAction.message)}
      >
        <Link2 className="h-3.5 w-3.5 text-ink-muted" aria-hidden />
        <span>{HEADING_ANCHOR_CONTEXT_MENU_LABELS.note}</span>
      </button>
    </div>,
    document.body
  );
}

// ── Main Plugin ──────────────────────────────────────────────────────────────

const PERSIST_DEBOUNCE_MS = 500;

interface CollapsibleHeadingPluginProps {
  noteId: string;
}

export function CollapsibleHeadingPlugin({ noteId }: CollapsibleHeadingPluginProps) {
  const [editor] = useLexicalComposerContext();
  const store = useStore();
  const noteEntity = useAtomValue(noteEntityAtom(noteId));
  const [collapsedKeys, setCollapsedKeys] = useState<Map<string, CollapseLevel>>(new Map());
  const [collapsedElements, setCollapsedElements] = useState<Map<string, HTMLElement>>(new Map());
  const [hoveredHeading, setHoveredHeading] = useState<HeadingInfo | null>(null);
  const [headingAnchorContextMenuState, setHeadingAnchorContextMenuState] = useState<HeadingAnchorContextMenuState>(
    initialHeadingAnchorContextMenuState
  );
  const rootElementRef = useRef<HTMLElement | null>(null);
  // Track elements styled in the previous apply cycle for scoped cleanup
  const styledElementsRef = useRef<{
    collapsed: HTMLElement[];
    semiChecked: HTMLElement[];
    semiLists: HTMLElement[];
    headingListKeys: Map<string, string[]>;
  }>({ collapsed: [], semiChecked: [], semiLists: [], headingListKeys: new Map() });
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Resolved scroll container for absolute chevron positioning
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  // Counter to force re-render when heading DOM positions change (typing, node insertion, checkbox toggle)
  const [_layoutTick, setLayoutTick] = useState(0);
  // Debounce timer for persisting collapsed headings to IPC
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether initial restore has happened to avoid persisting on first render
  const restoredRef = useRef(false);
  // Track lists with expanded completed items (user clicked "Completed" label)
  const [expandedLists, setExpandedLists] = useState<Set<string>>(new Set());

  const closeHeadingAnchorContextMenu = useCallback(() => {
    setHeadingAnchorContextMenuState(initialHeadingAnchorContextMenuState);
  }, []);

  // Surface a copy toast scoped to this editor pane. Dispatched as a bubbling
  // DOM event from the editor root so the canvas can show it without threading
  // a callback through every editor plugin.
  const emitNoteLinkCopied = useCallback((message: string) => {
    const rootElement = editor.getRootElement();
    if (!rootElement) return;
    const detail: NoteLinkCopiedEventDetail = { message };
    rootElement.dispatchEvent(
      new CustomEvent(NOTE_LINK_COPIED_EVENT, { bubbles: true, detail })
    );
  }, [editor]);

  const openHeadingAnchorContextMenu = useCallback((
    nodeKey: string,
    position: { x: number; y: number }
  ) => {
    let headingText = '';

    editor.read(() => {
      const node = $getNodeByKey(nodeKey);
      if (!$isHeadingNode(node)) return;
      headingText = stripWikiLinks(node.getTextContent()).trim();
    });

    if (!headingText) {
      return;
    }

    setHeadingAnchorContextMenuState({
      isVisible: true,
      position,
      nodeKey,
      headingText
    });
  }, [editor]);

  useEffect(() => {
    closeHeadingAnchorContextMenu();
  }, [closeHeadingAnchorContextMenu, noteId]);

  // Persist collapsed heading identities to atom + IPC (debounced)
  const persistCollapsedHeadings = useCallback((nextKeys: Map<string, CollapseLevel>) => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
    }

    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;

      // Build identity map from current editor state
      let identities: string[] = [];
      editor.read(() => {
        const { keyToIdentity } = buildHeadingMaps();
        identities = Array.from(nextKeys.entries())
          .map(([key, level]) => {
            const identity = keyToIdentity.get(key);
            return identity ? serializeIdentity(identity, level) : undefined;
          })
          .filter((id): id is string => id !== undefined);
      });

      // Update atom
      store.set(noteCollapsedHeadingsAtom(noteId), identities);

      // Persist to disk via IPC
      window.electronAPI?.notes.update(noteId, { collapsedHeadings: identities });
    }, PERSIST_DEBOUNCE_MS);
  }, [editor, noteId, store]);

  useEffect(() => editor.registerCommand(
    REVEAL_COLLAPSED_HEADING_COMMAND,
    ({ targetNodeKey }) => {
      const headingKeys = getCollapsedHeadingKeysContainingTarget(targetNodeKey, collapsedKeys);
      if (headingKeys.length === 0) return false;

      setCollapsedKeys((previous) => {
        const next = new Map(previous);
        for (const headingKey of headingKeys) next.delete(headingKey);
        persistCollapsedHeadings(next);
        return next;
      });
      return true;
    },
    COMMAND_PRIORITY_EDITOR
  ), [collapsedKeys, editor, persistCollapsedHeadings]);

  // Map saved heading identities to current node keys.
  // Used both on initial mount and after content reimport (agent writes).
  const restoreCollapsedFromIdentities = useCallback((savedIdentities: string[]): Map<string, CollapseLevel> => {
    const parsed = savedIdentities.map(parseIdentity);
    const restoredKeys = new Map<string, CollapseLevel>();

    editor.read(() => {
      const { identityToKey } = buildHeadingMaps();
      if (identityToKey.size === 0) return;

      for (const { identity, level } of parsed) {
        const nodeKey = identityToKey.get(identity);
        if (nodeKey) {
          const node = $getNodeByKey(nodeKey);
          if ($isHeadingNode(node) && hasCollapsibleContent(node)) {
            if (level === 'semi') {
              const taskInfo = getHeadingTaskInfo(node);
              if (taskInfo.hasCompleted && taskInfo.hasUncompleted) {
                restoredKeys.set(nodeKey, level);
              }
            } else {
              restoredKeys.set(nodeKey, level);
            }
          }
        }
      }
    });

    return restoredKeys;
  }, [editor]);

  // Restore collapsed state from atom on mount
  useEffect(() => {
    const savedIdentities = store.get(noteCollapsedHeadingsAtom(noteId));
    if (!savedIdentities || savedIdentities.length === 0) {
      restoredRef.current = true;
      return;
    }

    // Wait for editor to have content before restoring collapsed state.
    // Early updates (before markdown import) yield empty heading maps —
    // we must skip those and only restore once headings exist.
    const unregister = editor.registerUpdateListener(() => {
      const restoredKeys = restoreCollapsedFromIdentities(savedIdentities);

      // Wait for content to load before considering restoration done
      let headingsFound = false;
      editor.read(() => {
        const { identityToKey } = buildHeadingMaps();
        headingsFound = identityToKey.size > 0;
      });
      if (!headingsFound) return;
      unregister();

      if (restoredKeys.size > 0) {
        setCollapsedKeys(restoredKeys);
      }
      restoredRef.current = true;
    });

    return unregister;
  }, [editor, noteId, store, restoreCollapsedFromIdentities]);

  // Re-map collapsed keys after content reimport (e.g., agent disk writes).
  // The agent-content-update tag signals that root.clear() + reimport occurred,
  // giving all heading nodes new keys. We read the persisted identities from the
  // atom and map them back to the fresh keys.
  useEffect(() => {
    return editor.registerUpdateListener(({ tags }) => {
      if (!tags.has(EDITOR_UPDATE_TAGS.ignored.agentContentUpdate)) return;
      if (!restoredRef.current) return;

      const savedIdentities = store.get(noteCollapsedHeadingsAtom(noteId));
      if (!savedIdentities || savedIdentities.length === 0) {
        setCollapsedKeys(new Map());
        return;
      }

      const restoredKeys = restoreCollapsedFromIdentities(savedIdentities);
      setCollapsedKeys(restoredKeys);
      // Clear expanded-lists state — old list node keys are stale after reimport
      setExpandedLists(new Set());
    });
  }, [editor, noteId, store, restoreCollapsedFromIdentities]);

  // Toggle collapse state for a heading
  const toggleCollapse = useCallback((nodeKey: string) => {
    // Read heading info before updating state
    let hasCompleted = false;
    let hasUncompleted = false;
    const headingListKeys: string[] = [];

    editor.read(() => {
      const node = $getNodeByKey(nodeKey);
      if (!$isHeadingNode(node)) return;

      const taskInfo = getHeadingTaskInfo(node);
      hasCompleted = taskInfo.hasCompleted;
      hasUncompleted = taskInfo.hasUncompleted;

      // Collect check-list keys under this heading for expandedLists check
      const level = getHeadingLevel(node.getTag());
      let sibling = node.getNextSibling();
      while (sibling) {
        if ($isHeadingNode(sibling) && getHeadingLevel(sibling.getTag()) <= level) break;
        if ($isListNode(sibling) && sibling.getListType() === 'check') {
          headingListKeys.push(sibling.getKey());
        }
        sibling = sibling.getNextSibling();
      }
    });

    setCollapsedKeys((prev) => {
      const currentLevel = prev.get(nodeKey);

      // If semi-collapsed with unfurled completed items under THIS heading,
      // re-hide them instead of advancing to full collapse
      if (currentLevel === 'semi') {
        const hasExpandedLists = headingListKeys.some((k) => expandedLists.has(k));
        if (hasExpandedLists) {
          setExpandedLists((prevExpanded) => {
            const next = new Set(prevExpanded);
            headingListKeys.forEach((k) => next.delete(k));
            return next;
          });
          return prev;
        }
      }

      const next = new Map(prev);
      const nextLevel = nextCollapseLevel(currentLevel, hasCompleted, hasUncompleted);

      if (nextLevel === undefined) {
        next.delete(nodeKey);
      } else {
        next.set(nodeKey, nextLevel);
      }

      persistCollapsedHeadings(next);
      return next;
    });
  }, [editor, expandedLists, persistCollapsedHeadings]);

  // Cleanup persist timer on unmount
  useEffect(() => {
    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, []);

  // Resolve scroll container once on mount for absolute chevron positioning
  useEffect(() => {
    scrollContainerRef.current = editor.getRootElement()?.closest('.canvas-scroll') as HTMLElement | null;
  }, [editor]);

  // Reposition chevrons when the scroll container resizes (e.g., actions panel toggle)
  const needsObserverRef = useRef(false);
  needsObserverRef.current = !!hoveredHeading || collapsedKeys.size > 0;

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      if (needsObserverRef.current) {
        setLayoutTick((t) => t + 1);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [editor]);

  // Clear any pending hide timeout (called when mouse enters chevron)
  const clearHideTimeout = useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }, []);

  // Apply collapse styles to content elements and track collapsed heading elements.
  // Deferred to a microtask to avoid React 19's "flushSync was called from inside
  // a lifecycle method" warning — Lexical's editor.read() internally uses flushSync.
  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    queueMicrotask(() => {
      // Scoped cleanup: only touch elements we previously styled
      const prev = styledElementsRef.current;
      for (const el of prev.collapsed) el.classList.remove('heading-collapsed-content');
      for (const el of prev.semiChecked) el.classList.remove('heading-semi-collapsed-checked');
      for (const el of prev.semiLists) {
        el.classList.remove('heading-semi-collapsed-list');
        el.removeAttribute('data-list-key');
      }
      // Apply collapse styles and track elements for next cleanup
      const newCollapsedElements = new Map<string, HTMLElement>();
      const nextCollapsed: HTMLElement[] = [];
      const nextSemiChecked: HTMLElement[] = [];
      const nextSemiLists: HTMLElement[] = [];
      const nextHeadingListKeys = new Map<string, string[]>();

      editor.read(() => {
        collapsedKeys.forEach((level, nodeKey) => {
          const node = $getNodeByKey(nodeKey);
          if (!$isHeadingNode(node)) return;

          const headingElement = editor.getElementByKey(nodeKey);
          if (headingElement) {
            newCollapsedElements.set(nodeKey, headingElement as HTMLElement);
          }

          if (level === 'full') {
            const contentKeys = getCollapsibleContentKeys(node);
            for (const contentKey of contentKeys) {
              const el = editor.getElementByKey(contentKey);
              if (el) {
                el.classList.add('heading-collapsed-content');
                nextCollapsed.push(el as HTMLElement);
              }
            }
          } else if (level === 'semi') {
            const info = getSemiCollapseInfo(node, editor);
            const listKeysForHeading: string[] = [];

            info.checkedByList.forEach((elements, listKey) => {
              listKeysForHeading.push(listKey);
              if (expandedLists.has(listKey)) return;
              for (const el of elements) {
                el.classList.add('heading-semi-collapsed-checked');
                nextSemiChecked.push(el);
              }
            });

            info.listInfo.forEach(({ element: listElement }, listKey) => {
              if (!expandedLists.has(listKey)) {
                listElement.classList.add('heading-semi-collapsed-list');
                listElement.setAttribute('data-list-key', listKey);
                nextSemiLists.push(listElement);
              }
            });

            nextHeadingListKeys.set(nodeKey, listKeysForHeading);
          }
        });
      });

      styledElementsRef.current = { collapsed: nextCollapsed, semiChecked: nextSemiChecked, semiLists: nextSemiLists, headingListKeys: nextHeadingListKeys };
      setCollapsedElements(newCollapsedElements);
    });
  }, [editor, collapsedKeys, expandedLists, _layoutTick]);

  // Delegated click handler for "Completed N" pseudo-element label.
  // Clicks on ::before/::after register on the parent <ul> element in the padding-top area.
  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains('heading-semi-collapsed-list')) return;
      const listKey = target.getAttribute('data-list-key');
      if (!listKey) return;

      // Only trigger when clicking in the ::before label area (top portion of the list)
      const rect = target.getBoundingClientRect();
      const clickY = e.clientY - rect.top;
      const beforeHeight = parseFloat(getComputedStyle(target, '::before').height) || 24;
      if (clickY > beforeHeight) return;

      e.preventDefault();
      e.stopPropagation();

      // Find the heading that owns this list and uncollapse it
      const { headingListKeys } = styledElementsRef.current;
      let ownerHeadingKey: string | null = null;
      headingListKeys.forEach((listKeys, headingKey) => {
        if (listKeys.includes(listKey)) ownerHeadingKey = headingKey;
      });

      if (ownerHeadingKey) {
        const key = ownerHeadingKey;
        setCollapsedKeys((prev) => {
          const next = new Map(prev);
          next.delete(key);
          persistCollapsedHeadings(next);
          return next;
        });
      }
    };

    rootElement.addEventListener('click', handleClick);
    return () => rootElement.removeEventListener('click', handleClick);
  }, [editor, collapsedKeys, persistCollapsedHeadings]);

  // ListItemNode mutation listener — re-apply semi-collapse when checkboxes toggle
  useEffect(() => {
    // Only register if any heading is in semi state
    const hasSemi = Array.from(collapsedKeys.values()).some((l) => l === 'semi');
    if (!hasSemi) return;

    const unregister = editor.registerMutationListener(ListItemNode, (mutations) => {
      let hasUpdate = false;
      for (const [, type] of mutations) {
        if (type === 'updated') {
          hasUpdate = true;
          break;
        }
      }
      if (!hasUpdate) return;

      // Re-check task info for all semi-collapsed headings
      setCollapsedKeys((prev) => {
        let changed = false;
        const next = new Map(prev);
        const transitionedHeadingKeys: string[] = [];

        editor.read(() => {
          for (const [nodeKey, level] of prev) {
            if (level !== 'semi') continue;
            const node = $getNodeByKey(nodeKey);
            if (!$isHeadingNode(node)) continue;

            const taskInfo = getHeadingTaskInfo(node);
            // If no completed tasks remain, auto-expand
            if (!taskInfo.hasCompleted) {
              next.delete(nodeKey);
              changed = true;
              transitionedHeadingKeys.push(nodeKey);
            }
            // If no uncompleted tasks remain, transition to full collapse
            else if (!taskInfo.hasUncompleted) {
              next.set(nodeKey, 'full');
              changed = true;
              transitionedHeadingKeys.push(nodeKey);
            }
          }
        });

        if (changed) {
          // Clean up expanded-lists state for headings leaving semi-collapse
          if (transitionedHeadingKeys.length > 0) {
            const { headingListKeys: hlk } = styledElementsRef.current;
            const listKeysToRemove = transitionedHeadingKeys.flatMap((hk) => hlk.get(hk) ?? []);
            if (listKeysToRemove.length > 0) {
              setExpandedLists((prevExpanded) => {
                const nextExpanded = new Set(prevExpanded);
                listKeysToRemove.forEach((k) => nextExpanded.delete(k));
                return nextExpanded;
              });
            }
          }
          persistCollapsedHeadings(next);
          return next;
        }
        // Return same ref to avoid unnecessary re-render; the apply effect
        // will re-run due to collapsedKeys being in its deps already via the
        // mutation triggering a Lexical update → heading reposition effect → scrollTick
        return prev;
      });

      // Force re-apply of CSS classes (the checked item DOM changed)
      setLayoutTick((t) => t + 1);
    });

    return unregister;
  }, [editor, collapsedKeys, persistCollapsedHeadings]);

  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    const handleContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('[data-file-link-node-key]')) {
        return;
      }

      const headingElement = target.closest('h1, h2, h3, h4') as HTMLElement | null;
      if (!headingElement || !rootElement.contains(headingElement)) {
        return;
      }

      let nodeKey: string | null = null;
      editor.read(() => {
        const node = $getNearestNodeFromDOMNode(headingElement);
        if ($isHeadingNode(node)) {
          nodeKey = node.getKey();
        }
      });

      if (!nodeKey) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      openHeadingAnchorContextMenu(nodeKey, { x: event.clientX, y: event.clientY });
    };

    rootElement.addEventListener('contextmenu', handleContextMenu);
    return () => rootElement.removeEventListener('contextmenu', handleContextMenu);
  }, [editor, openHeadingAnchorContextMenu]);

  // Track mouse events on headings
  // mouseoverRafRef throttles mouseover → editor.read() to one call per animation frame.
  // pendingHeadingRef stores the latest heading so fast mouse movements between
  // headings within a single frame always resolve to the correct element.
  const mouseoverRafRef = useRef<number | null>(null);
  const pendingHeadingRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    rootElementRef.current = rootElement;

    const handleMouseOver = (event: MouseEvent) => {
      // Clear any pending hide timeout
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = null;
      }

      const target = event.target as HTMLElement;
      const headingElement = target.closest('h1, h2, h3, h4') as HTMLElement | null;

      if (headingElement && rootElement.contains(headingElement)) {
        // Always store the latest heading; only schedule rAF if not pending
        pendingHeadingRef.current = headingElement;
        if (mouseoverRafRef.current !== null) return;
        mouseoverRafRef.current = requestAnimationFrame(() => {
          mouseoverRafRef.current = null;
          const resolvedHeading = pendingHeadingRef.current;
          if (!resolvedHeading || !rootElement.contains(resolvedHeading)) return;

          // Find the Lexical node for this element using Lexical's DOM mapping
          // Must use editor.read() (not editor.getEditorState().read()) to have active editor context
          let nodeKey: string | null = null;
          let hasContent = false;

          editor.read(() => {
            const node = $getNearestNodeFromDOMNode(resolvedHeading);
            if (node && $isHeadingNode(node)) {
              nodeKey = node.getKey();
              hasContent = hasCollapsibleContent(node);
            }
          });

          if (nodeKey && hasContent) {
            setHoveredHeading({ nodeKey, element: resolvedHeading, hasContent });
          }
        });
      }
    };

    const handleMouseOut = (event: MouseEvent) => {
      const relatedTarget = event.relatedTarget as HTMLElement | null;

      // Don't hide if moving to the chevron button
      if (relatedTarget?.closest('.collapsible-heading-chevron')) {
        return;
      }

      // Don't hide if moving to another part of the same heading
      if (relatedTarget?.closest('h1, h2, h3, h4')) {
        return;
      }

      // Add a delay to allow moving to the chevron
      hideTimeoutRef.current = setTimeout(() => {
        // Check if mouse is now over chevron
        const chevron = document.querySelector('.collapsible-heading-chevron:hover');
        if (!chevron) {
          setHoveredHeading(null);
        }
        hideTimeoutRef.current = null;
      }, 300);
    };

    const handleChevronMouseOut = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const relatedTarget = event.relatedTarget as HTMLElement | null;

      if (target.closest('.collapsible-heading-chevron')) {
        if (relatedTarget && rootElement.contains(relatedTarget)) {
          const headingElement = relatedTarget.closest('h1, h2, h3, h4');
          if (headingElement) {
            return;
          }
        }
        setHoveredHeading(null);
      }
    };

    rootElement.addEventListener('mouseover', handleMouseOver);
    rootElement.addEventListener('mouseout', handleMouseOut);
    document.addEventListener('mouseout', handleChevronMouseOut);

    return () => {
      rootElement.removeEventListener('mouseover', handleMouseOver);
      rootElement.removeEventListener('mouseout', handleMouseOut);
      document.removeEventListener('mouseout', handleChevronMouseOut);
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
      if (mouseoverRafRef.current !== null) {
        cancelAnimationFrame(mouseoverRafRef.current);
        mouseoverRafRef.current = null;
      }
    };
  }, [editor, hoveredHeading, collapsedKeys.size]);

  // Reposition chevrons when heading nodes move/change (e.g., hitting Enter on a heading)
  useEffect(() => {
    if (!hoveredHeading && collapsedKeys.size === 0) {
      return;
    }

    return editor.registerUpdateListener(({ editorState, dirtyElements }) => {
      let headingTouched = false;
      editorState.read(() => {
        for (const [key] of dirtyElements) {
          const node = $getNodeByKey(key);
          if ($isHeadingNode(node)) {
            headingTouched = true;
            break;
          }
        }
      });

      if (headingTouched) {
        setLayoutTick((t) => t + 1);
      }
    });
  }, [editor, hoveredHeading, collapsedKeys.size]);

  // Render chevrons for:
  // 1. All collapsed headings (always visible)
  // 2. Hovered heading (if not already collapsed)
  const chevronsToRenderByKey = new Map<string, { nodeKey: string; element: HTMLElement; collapseLevel: CollapseLevel | undefined }>();

  // Add all collapsed headings
  const { headingListKeys } = styledElementsRef.current;
  collapsedElements.forEach((element, nodeKey) => {
    let level = collapsedKeys.get(nodeKey);
    // If semi but all lists are user-expanded, show as visually expanded
    if (level === 'semi') {
      const listKeys = headingListKeys.get(nodeKey);
      if (listKeys && listKeys.length > 0 && listKeys.every((k) => expandedLists.has(k))) {
        level = undefined;
      }
    }
    chevronsToRenderByKey.set(nodeKey, { nodeKey, element, collapseLevel: level });
  });

  // Add hovered heading if not already in collapsed list
  if (hoveredHeading && !collapsedKeys.has(hoveredHeading.nodeKey)) {
    chevronsToRenderByKey.set(hoveredHeading.nodeKey, {
      nodeKey: hoveredHeading.nodeKey,
      element: hoveredHeading.element,
      collapseLevel: undefined
    });
  }

  const chevronsToRender = [...chevronsToRenderByKey.values()];
  const scrollContainer = scrollContainerRef.current;
  const headingAnchorContextMenu = (
    <HeadingAnchorContextMenu
      state={headingAnchorContextMenuState}
      noteId={noteId}
      noteTitle={noteEntity?.title ?? 'Untitled'}
      folderPath={noteEntity?.folderPath}
      filesystemPath={noteEntity?.contentPath ?? noteEntity?.externalFilePath}
      onClose={closeHeadingAnchorContextMenu}
      onCopied={emitNoteLinkCopied}
    />
  );

  if (chevronsToRender.length === 0 || !scrollContainer) {
    return headingAnchorContextMenuState.isVisible ? headingAnchorContextMenu : null;
  }

  return (
    <>
      {chevronsToRender.map(({ nodeKey, element, collapseLevel }) => (
        <ChevronOverlay
          key={nodeKey}
          headingElement={element}
          scrollContainer={scrollContainer}
          collapseLevel={collapseLevel}
          onToggle={() => toggleCollapse(nodeKey)}
          onHoverStart={() => {
            clearHideTimeout();
            setHoveredHeading((prev) => (
              prev?.nodeKey === nodeKey && prev.element === element
                ? prev
                : { nodeKey, element, hasContent: true }
            ));
          }}
          onOpenContextMenu={(event) => {
            openHeadingAnchorContextMenu(nodeKey, {
              x: event.clientX,
              y: event.clientY
            });
          }}
        />
      ))}
      {headingAnchorContextMenu}
    </>
  );
}

// ── Test Exports ─────────────────────────────────────────────────────────────
// Exported for unit testing only. Not part of the public API.

export const __test__ = {
  getHeadingLevel,
  getCollapsibleContentKeys,
  getCollapsedHeadingKeysContainingTarget,
  hasCollapsibleContent,
  getWrapperOwner,
  getHeadingTaskInfo,
  getSemiCollapseInfo,
  nextCollapseLevel,
  buildHeadingMaps,
  parseIdentity,
  serializeIdentity,
  computeChevronStyle,
  CHEVRON_TARGET_SIZE,
  CHEVRON_ICON_CENTER_OFFSET,
  HEADING_ANCHOR_CONTEXT_MENU_LABELS,
  buildHeadingCopyAction
};
