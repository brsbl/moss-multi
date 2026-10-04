// ported-from: packages/desktop/src/renderer/editor/plugins/TabBarPlugin.tsx @ 762abb777
/**
 * TabBarPlugin - Renders tab bar UI as React portals into TabGroupNode
 * `.moss-tab-bar` DOM slots. Handles tab switching, adding, removing, renaming.
 *
 * Pattern: mutation listener + portal into the setDOMUnmanaged tab bar slot
 * inside TabGroupNode's createDOM.
 */

import type { JSX, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, SyntheticEvent, TouchEvent } from 'react';
import { Fragment } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createParagraphNode,
  $getNodeByKey,
  HISTORY_PUSH_TAG,
  type NodeMutation
} from 'lexical';
import { MoreVertical, Plus, PenLine, CopyMinus, Trash2 } from 'lucide-react';
import { TabGroupNode, $isTabGroupNode } from '../nodes/TabGroupNode';
import { TabPanelNode, $isTabPanelNode, $createTabPanelNode } from '../nodes/TabPanelNode';
import { EDITOR_UPDATE_TAGS } from '../utils/editorUpdateTags';

// ── Types ────────────────────────────────────────────────────────────────

interface TabGroupInfo {
  key: string;
  tabBarElement: HTMLElement;
}

interface TabData {
  key: string;
  label: string;
  isActive: boolean;
  // Pinned title width in px, or null when the tab uses the auto/default cap.
  pinnedWidthPx: number | null;
}

function stopLexicalRootEvent(event: SyntheticEvent): void {
  event.stopPropagation();
  event.nativeEvent.stopImmediatePropagation?.();
}

function stopNativeEvent(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

const TAB_TITLE_MIN_WIDTH_PX = 36;
const TAB_TITLE_INTRINSIC_MIN_MAX_PX = 96;
const TAB_TITLE_KEYBOARD_STEP_PX = 16;
const TAB_TITLE_RESIZE_KEYS = new Set([
  'ArrowRight',
  'ArrowUp',
  'ArrowLeft',
  'ArrowDown',
  'Home',
  'End',
  'Backspace',
  'Delete',
  'Enter',
  ' ',
  'Spacebar'
]);
const TAB_RESIZE_HANDLE_WIDTH_PX = 24;
const TAB_TITLE_CHROME_RESERVE_PX =
  24 + (28 + 4) + 24 + 4 + 24 + TAB_RESIZE_HANDLE_WIDTH_PX;

function measureTabTitleMinimumWidth(title: HTMLElement): number {
  const clone = title.cloneNode(true) as HTMLElement;
  clone.style.position = 'fixed';
  clone.style.left = '-10000px';
  clone.style.top = '0';
  clone.style.display = 'inline-block';
  clone.style.visibility = 'hidden';
  clone.style.width = 'auto';
  clone.style.maxWidth = 'none';
  clone.style.flex = 'none';
  clone.style.whiteSpace = 'nowrap';
  (title.parentElement ?? document.body).appendChild(clone);
  const measured = Math.ceil(
    clone.getBoundingClientRect().width || clone.scrollWidth || title.scrollWidth
  );
  clone.remove();
  return Math.min(
    TAB_TITLE_INTRINSIC_MIN_MAX_PX,
    Math.max(TAB_TITLE_MIN_WIDTH_PX, measured)
  );
}

const TAB_OPTIONS_MENU_CLASS =
  'z-50 min-w-32 overflow-hidden rounded-md border border-border-subtle bg-surface-floating p-1 text-ink-default shadow-md';

const TAB_OPTIONS_MENU_ITEM_CLASS =
  'relative flex w-full cursor-pointer select-none appearance-none items-center gap-2 rounded-sm border-0 bg-surface-transparent px-2 py-1.5 text-left text-sm font-normal outline-none transition-colors hover:bg-surface-canvas focus:bg-surface-canvas';

const RENAME_NAVIGATION_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown'
]);

const RENAME_EDITING_SHORTCUT_KEYS = new Set(['a', 'x', 'v', 'z', 'y']);

// ── Panel visibility helper ──────────────────────────────────────────────

export function updatePanelVisibility(
  editor: ReturnType<typeof useLexicalComposerContext>[0],
  nodeKey: string,
  activeIndex: number
): void {
  const groupDom = editor.getElementByKey(nodeKey);
  if (!groupDom) return;
  const panels = groupDom.querySelectorAll('[data-tab-panel]');
  panels.forEach((panel, i) => {
    if (i === activeIndex) {
      (panel as HTMLElement).style.display = '';
      panel.setAttribute('data-active', '');
    } else {
      (panel as HTMLElement).style.display = 'none';
      panel.removeAttribute('data-active');
    }
  });
}

// ── TabBar portal component ──────────────────────────────────────────────

function TabBar({
  nodeKey,
  editor
}: {
  nodeKey: string;
  editor: ReturnType<typeof useLexicalComposerContext>[0];
}): JSX.Element {
  const [tabData, setTabData] = useState<TabData[]>([]);
  const [editingTabKey, setEditingTabKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [renameInputRect, setRenameInputRect] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  const [isOptionsMenuOpen, setIsOptionsMenuOpen] = useState(false);
  const [optionsMenuPosition, setOptionsMenuPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [dragWidthState, setDragWidthState] = useState<{
    tabIndex: number;
    widthPx: number | null;
  } | null>(null);
  const [tabGroupWidthPx, setTabGroupWidthPx] = useState<number | null>(null);
  const [measuredTabTitleWidthsPx, setMeasuredTabTitleWidthsPx] = useState<number[]>([]);
  const [tabTitleMinWidthsPx, setTabTitleMinWidthsPx] = useState<number[]>([]);
  const [resizeDragActive, setResizeDragActive] = useState(false);
  const [isEditorEditable, setIsEditorEditable] = useState(() => editor.isEditable());
  const [draggingTabKey, setDraggingTabKey] = useState<string | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    tabIndex: number;
    startX: number;
    startWidth: number;
    minWidth: number;
    groupContentWidth: number;
    nextWidth: number;
    hasMoved: boolean;
  } | null>(null);
  const keyboardResizeStateRef = useRef<{
    tabIndex: number;
    widthPx: number | null;
  } | null>(null);
  const reorderDragStateRef = useRef<{
    pointerId: number;
    fromIndex: number;
    tabKey: string;
    startX: number;
    startY: number;
    hasDragged: boolean;
  } | null>(null);
  const skipNextTabClickRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameAnchorRef = useRef<HTMLSpanElement>(null);
  const optionsButtonRef = useRef<HTMLButtonElement>(null);
  const optionsMenuRef = useRef<HTMLDivElement>(null);
  const skipBlurCommitRef = useRef(false);
  const outsideRenamePointerRef = useRef(false);
  const pendingRenameFocusRef = useRef<{ tabKey: string; label: string } | null>(null);
  const lastTitleTapRef = useRef<{ tabKey: string; time: number } | null>(null);
  const menuRenameHandoffRef = useRef<{
    tabKey: string;
    label: string;
    timeoutId: number;
  } | null>(null);

  useEffect(() => {
    setIsEditorEditable(editor.isEditable());
    return editor.registerEditableListener(setIsEditorEditable);
  }, [editor]);
  const nativeMenuCleanupRef = useRef<(() => void) | null>(null);
  const scheduledMenuRenameRef = useRef<number | null>(null);
  const focusFirstMenuItemOnOpenRef = useRef(false);

  // Read tab state from editor
  const readState = useCallback(() => {
    editor.getEditorState().read(() => {
      const node = $getNodeByKey(nodeKey);
      if (!$isTabGroupNode(node)) return;
      const activeIndex = node.getActiveIndex();
      const panels = node.getTabPanels();
      const tabWidths = node.getTabWidths();
      setTabData(
        panels.map((p, i) => ({
          key: p.getKey(),
          label: p.getLabel(),
          isActive: i === activeIndex,
          pinnedWidthPx: tabWidths[i] ?? null
        }))
      );
    });
  }, [editor, nodeKey]);

  // Subscribe to panel mutations (scoped to this group)
  useEffect(() => {
    readState();
    return editor.registerMutationListener(TabPanelNode, (mutations) => {
      editor.getEditorState().read(() => {
        const node = $getNodeByKey(nodeKey);
        if (!$isTabGroupNode(node)) return;
        const panelKeys = new Set(node.getTabPanels().map(p => p.getKey()));
        for (const key of mutations.keys()) {
          if (panelKeys.has(key)) {
            readState();
            return;
          }
        }
      });
    });
  }, [editor, nodeKey, readState]);

  // Subscribe to TabGroupNode mutations (activeIndex changes)
  useEffect(() => {
    return editor.registerMutationListener(TabGroupNode, (mutations) => {
      if (mutations.has(nodeKey)) {
        readState();
      }
    });
  }, [editor, nodeKey, readState]);

  // Sync panel visibility whenever tabData changes
  useEffect(() => {
    const activeIndex = tabData.findIndex((t) => t.isActive);
    if (activeIndex >= 0) {
      updatePanelVisibility(editor, nodeKey, activeIndex);
    }
  }, [editor, nodeKey, tabData]);

  useEffect(() => {
    const tabBar = tabBarRef.current;
    const surface = tabBar?.closest<HTMLElement>('.moss-tab-group');
    if (!tabBar || !surface) {
      return undefined;
    }

    const applyAutoMax = () => {
      if (dragStateRef.current) {
        return;
      }
      const groupContentWidth = surface.clientWidth;
      if (groupContentWidth <= 0) {
        return;
      }
      setTabGroupWidthPx(groupContentWidth);
      const autoMaxPx = Math.max(
        TAB_TITLE_MIN_WIDTH_PX,
        groupContentWidth - TAB_TITLE_CHROME_RESERVE_PX
      );
      tabBar.style.setProperty('--moss-tab-title-max', `${autoMaxPx}px`);
      const titles = Array.from(
        tabBar.querySelectorAll<HTMLElement>('[data-tab-title]')
      );
      const measuredMinWidths = titles.map(measureTabTitleMinimumWidth);
      const measuredWidths = titles.map((title, index) => Math.min(
        groupContentWidth,
        Math.max(
          measuredMinWidths[index],
          Math.round(title.getBoundingClientRect().width)
        )
      ));
      setMeasuredTabTitleWidthsPx((current) =>
        current.length === measuredWidths.length &&
        current.every((width, index) => width === measuredWidths[index])
          ? current
          : measuredWidths
      );
      setTabTitleMinWidthsPx((current) =>
        current.length === measuredMinWidths.length &&
        current.every((width, index) => width === measuredMinWidths[index])
          ? current
          : measuredMinWidths
      );
    };

    applyAutoMax();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(applyAutoMax);
    observer.observe(surface);
    return () => {
      observer.disconnect();
    };
  }, [tabData]);

  const clearEditorDomSelection = useCallback(() => {
    const root = editor.getRootElement();
    const selection = root?.ownerDocument.defaultView?.getSelection();
    if (!root || !selection || selection.rangeCount === 0) {
      return;
    }

    const { anchorNode, focusNode } = selection;
    if (
      (anchorNode && root.contains(anchorNode)) ||
      (focusNode && root.contains(focusNode))
    ) {
      selection.removeAllRanges();
    }
  }, [editor]);

  const focusRenameInput = useCallback((expectedValue: string): boolean => {
    const input = inputRef.current;
    if (!input || input.value !== expectedValue) {
      return false;
    }

    clearEditorDomSelection();
    input.focus({ preventScroll: true });
    input.setSelectionRange(0, expectedValue.length, 'forward');
    clearEditorDomSelection();
    return true;
  }, [clearEditorDomSelection]);

  const focusRenameInputPreservingSelection = useCallback(
    (
      selectionStart: number | null,
      selectionEnd: number | null,
      selectionDirection: 'forward' | 'backward' | 'none' | null
    ): boolean => {
      const input = inputRef.current;
      if (!input) {
        return false;
      }

      clearEditorDomSelection();
      input.focus({ preventScroll: true });
      if (selectionStart !== null && selectionEnd !== null) {
        input.setSelectionRange(selectionStart, selectionEnd, selectionDirection ?? undefined);
      }
      clearEditorDomSelection();
      return true;
    },
    [clearEditorDomSelection]
  );

  const closeOptionsMenu = useCallback(() => {
    const cleanup = nativeMenuCleanupRef.current;
    if (cleanup) {
      nativeMenuCleanupRef.current = null;
      cleanup();
    }
    focusFirstMenuItemOnOpenRef.current = false;
    setIsOptionsMenuOpen(false);
    setOptionsMenuPosition(null);
  }, []);

  const clearScheduledMenuRename = useCallback(() => {
    const scheduledMenuRename = scheduledMenuRenameRef.current;
    if (scheduledMenuRename !== null) {
      window.clearTimeout(scheduledMenuRename);
      scheduledMenuRenameRef.current = null;
    }
  }, []);

  const clearMenuRenameHandoff = useCallback(() => {
    const handoff = menuRenameHandoffRef.current;
    if (handoff) {
      window.clearTimeout(handoff.timeoutId);
      menuRenameHandoffRef.current = null;
    }
  }, []);

  const clearMenuRenameHandoffForInputInteraction = useCallback(() => {
    if (menuRenameHandoffRef.current?.tabKey === editingTabKey) {
      clearMenuRenameHandoff();
    }
  }, [clearMenuRenameHandoff, editingTabKey]);

  const startMenuRenameHandoff = useCallback((tabKey: string, label: string) => {
    clearMenuRenameHandoff();
    const timeoutId = window.setTimeout(() => {
      const handoff = menuRenameHandoffRef.current;
      if (handoff?.tabKey === tabKey && handoff.label === label) {
        menuRenameHandoffRef.current = null;
      }
    }, 1500);
    menuRenameHandoffRef.current = { tabKey, label, timeoutId };
  }, [clearMenuRenameHandoff]);

  const refocusMenuRenameInput = useCallback((
    tabKey: string,
    label: string,
    selection?: {
      start: number | null;
      end: number | null;
      direction: 'forward' | 'backward' | 'none' | null;
    }
  ) => {
    const refocus = () => {
      const handoff = menuRenameHandoffRef.current;
      if (handoff?.tabKey === tabKey && handoff.label === label) {
        if (selection) {
          focusRenameInputPreservingSelection(
            selection.start,
            selection.end,
            selection.direction
          );
        } else {
          focusRenameInput(label);
        }
      }
    };

    window.setTimeout(refocus, 0);
    requestAnimationFrame(() => {
      refocus();
      requestAnimationFrame(refocus);
    });
  }, [focusRenameInput, focusRenameInputPreservingSelection]);

  useEffect(() => {
    return () => {
      closeOptionsMenu();
      clearScheduledMenuRename();
      clearMenuRenameHandoff();
    };
  }, [closeOptionsMenu, clearScheduledMenuRename, clearMenuRenameHandoff]);

  useLayoutEffect(() => {
    if (!isOptionsMenuOpen || !focusFirstMenuItemOnOpenRef.current) {
      return;
    }
    focusFirstMenuItemOnOpenRef.current = false;
    optionsMenuRef.current
      ?.querySelector<HTMLElement>('[data-tab-action]')
      ?.focus({ preventScroll: true });
  }, [isOptionsMenuOpen]);

  // Focus input when editing starts. The deferred passes make selection robust
  // against browser double-click selection and menu handoff focus shifts.
  useLayoutEffect(() => {
    const pendingRename = pendingRenameFocusRef.current;
    if (
      !editingTabKey ||
      !pendingRename ||
      pendingRename.tabKey !== editingTabKey ||
      editValue !== pendingRename.label
    ) {
      return undefined;
    }

    let rafId: number | null = null;
    let secondRafId: number | null = null;
    const expectedValue = pendingRename.label;
    const isMenuRename =
      menuRenameHandoffRef.current?.tabKey === pendingRename.tabKey &&
      menuRenameHandoffRef.current.label === pendingRename.label;
    const focusIfMenuRenameHandoffActive = () => {
      const handoff = menuRenameHandoffRef.current;
      if (handoff?.tabKey === pendingRename.tabKey && handoff.label === expectedValue) {
        focusRenameInput(expectedValue);
      }
    };
    const finishRenameFocus = (): boolean => {
      const didFocus = focusRenameInput(expectedValue);
      if (
        didFocus &&
        pendingRenameFocusRef.current?.tabKey === pendingRename.tabKey &&
        pendingRenameFocusRef.current.label === pendingRename.label
      ) {
        pendingRenameFocusRef.current = null;
      }
      return didFocus;
    };
    const timeoutId = window.setTimeout(() => focusRenameInput(expectedValue), 0);

    focusRenameInput(expectedValue);
    rafId = requestAnimationFrame(() => {
      focusRenameInput(expectedValue);
      secondRafId = requestAnimationFrame(() => {
        finishRenameFocus();
      });
    });
    const laterFocusIds = isMenuRename
      ? [
          window.setTimeout(focusIfMenuRenameHandoffActive, 100),
          window.setTimeout(focusIfMenuRenameHandoffActive, 450),
          window.setTimeout(focusIfMenuRenameHandoffActive, 900)
        ]
      : [];

    return () => {
      window.clearTimeout(timeoutId);
      for (const focusId of laterFocusIds) {
        window.clearTimeout(focusId);
      }
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      if (secondRafId !== null) {
        cancelAnimationFrame(secondRafId);
      }
    };
  }, [editingTabKey, editValue, focusRenameInput]);

  const handleTabClick = useCallback(
    (index: number) => {
      closeOptionsMenu();
      editor.update(
        () => {
          const node = $getNodeByKey(nodeKey);
          if (!$isTabGroupNode(node)) return;
          node.setActiveIndex(index);
          const panel = node.getTabPanels()[index];
          if (panel) panel.selectStart();
        },
        { tag: EDITOR_UPDATE_TAGS.ignored.skipDirty }
      );
      updatePanelVisibility(editor, nodeKey, index);
      // Re-focus editor after clicking the non-editable tab bar
      editor.focus();
    },
    [editor, nodeKey, closeOptionsMenu]
  );

  const handleAddTab = useCallback(() => {
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (!$isTabGroupNode(node)) return;
      const panels = node.getTabPanels();
      const panel = $createTabPanelNode(`Tab ${panels.length + 1}`);
      panel.append($createParagraphNode());
      node.append(panel);
      const newIndex = node.getTabPanels().length - 1;
      node.setActiveIndex(newIndex);
      panel.selectStart();
    });
  }, [editor, nodeKey]);

  const handleRemoveTab = useCallback(
    (tabIndex: number) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if (!$isTabGroupNode(node)) return;
        const panels = node.getTabPanels();
        if (panels.length <= 1) {
          const paragraph = $createParagraphNode();
          node.insertBefore(paragraph);
          node.remove();
          paragraph.select();
          return;
        }
        const currentWidths = node.getTabWidths();
        if (currentWidths.length > 0) {
          const nextWidths = currentWidths.slice(0, panels.length);
          nextWidths.splice(tabIndex, 1);
          node.setTabWidths(nextWidths.some((width) => width != null) ? nextWidths : []);
        }
        panels[tabIndex].remove();
        const newIndex = Math.min(tabIndex, panels.length - 2);
        node.setActiveIndex(newIndex);
        const newPanel = node.getTabPanels()[newIndex];
        if (newPanel) newPanel.selectStart();
      });
    },
    [editor, nodeKey]
  );

  const handleKeepOnly = useCallback(
    (tabIndex: number) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if (!$isTabGroupNode(node)) return;
        const panels = node.getTabPanels();
        const activePanel = panels[tabIndex];
        if (!activePanel) return;
        // Set activeIndex so undo restores with correct tab focused
        node.setActiveIndex(tabIndex);
        // Move panel children directly — preserves MarkNodes (comments),
        // DecoratorNodes, and all other node types without lossy roundtrip.
        const children = activePanel.getChildren();
        let insertPoint: import('lexical').LexicalNode = node;
        for (const child of children) {
          insertPoint.insertAfter(child);
          insertPoint = child;
        }
        node.remove();
        // Select end of last inserted node
        const last = children[children.length - 1];
        if (last && 'selectEnd' in last && typeof last.selectEnd === 'function') {
          (last as { selectEnd: () => void }).selectEnd();
        }
      });
    },
    [editor, nodeKey]
  );

  const commitTabWidthAtIndex = useCallback(
    (
      tabIndex: number,
      widthPx: number | null,
      historyTag?: typeof HISTORY_PUSH_TAG
    ) => {
      if (!editor.isEditable()) {
        return;
      }
      editor.update(
        () => {
          const node = $getNodeByKey(nodeKey);
          if (!$isTabGroupNode(node)) return;
          const panelCount = node.getTabPanels().length;
          if (tabIndex < 0 || tabIndex >= panelCount) return;
          const current = node.getTabWidths();
          if ((current[tabIndex] ?? null) === widthPx) return;
          const next: (number | null)[] = [];
          for (let i = 0; i < panelCount; i += 1) {
            next[i] = current[i] ?? null;
          }
          next[tabIndex] = widthPx;
          node.setTabWidths(next.some((width) => width !== null) ? next : []);
        },
        { tag: historyTag ? ['tab-title-resize', historyTag] : 'tab-title-resize' }
      );
    },
    [editor, nodeKey]
  );

  const getTabTitleResizeMetrics = useCallback(
    (tabIndex: number): { currentWidth: number; minWidth: number; maxWidth: number } | null => {
      const titleSpan = tabBarRef.current
        ?.querySelectorAll<HTMLElement>('[data-tab-title]')[tabIndex];
      const surface = tabBarRef.current?.closest<HTMLElement>('.moss-tab-group');
      if (!titleSpan || !surface) {
        return null;
      }

      const measuredWidth = Math.round(titleSpan.getBoundingClientRect().width);
      const minWidth = measureTabTitleMinimumWidth(titleSpan);
      const pinnedWidth = tabData[tabIndex]?.pinnedWidthPx ?? null;
      const maxWidth = Math.max(minWidth, surface.clientWidth);
      const currentWidth = Math.min(
        maxWidth,
        Math.max(
          minWidth,
          pinnedWidth ?? (measuredWidth > 0 ? measuredWidth : TAB_TITLE_MIN_WIDTH_PX)
        )
      );
      setTabGroupWidthPx((current) => current === maxWidth ? current : maxWidth);
      setMeasuredTabTitleWidthsPx((current) => {
        if (current[tabIndex] === currentWidth) {
          return current;
        }
        const next = [...current];
        next[tabIndex] = currentWidth;
        return next;
      });
      return { currentWidth, minWidth, maxWidth };
    },
    [tabData]
  );

  const endTabResizeDrag = useCallback(() => {
    const drag = dragStateRef.current;
    dragStateRef.current = null;
    setDragWidthState(null);
    setResizeDragActive(false);
    document.body.style.cursor = '';
    if (drag) {
      if (drag.hasMoved) {
        commitTabWidthAtIndex(drag.tabIndex, drag.nextWidth);
      }
    }
  }, [commitTabWidthAtIndex]);

  const handleResizeHandlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, tabIndex: number) => {
      if (!editor.isEditable()) {
        return;
      }
      keyboardResizeStateRef.current = null;
      event.preventDefault();
      stopLexicalRootEvent(event);
      const handle = event.currentTarget;
      const titleSpan = tabBarRef.current
        ?.querySelectorAll<HTMLElement>('[data-tab-title]')[tabIndex];
      const surface = tabBarRef.current?.closest<HTMLElement>('.moss-tab-group');
      if (!titleSpan || !surface) {
        return;
      }
      const startWidth = titleSpan.getBoundingClientRect().width;
      const minWidth = measureTabTitleMinimumWidth(titleSpan);
      const initialWidth = Math.max(minWidth, Math.round(startWidth));
      dragStateRef.current = {
        pointerId: event.pointerId,
        tabIndex,
        startX: event.clientX,
        startWidth: initialWidth,
        minWidth,
        groupContentWidth: Math.max(minWidth, surface.clientWidth),
        nextWidth: initialWidth,
        hasMoved: false
      };
      handle.setPointerCapture?.(event.pointerId);
      document.body.style.cursor = 'col-resize';
      setResizeDragActive(true);
    },
    [editor]
  );

  const handleResizeHandleDoubleClick = useCallback(
    (event: ReactPointerEvent<HTMLDivElement> | SyntheticEvent, tabIndex: number) => {
      if (!editor.isEditable()) {
        return;
      }
      keyboardResizeStateRef.current = null;
      event.preventDefault();
      stopLexicalRootEvent(event);
      dragStateRef.current = null;
      setDragWidthState(null);
      setResizeDragActive(false);
      document.body.style.cursor = '';
      commitTabWidthAtIndex(tabIndex, null);
    },
    [commitTabWidthAtIndex, editor]
  );

  const handleResizeHandleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>, tabIndex: number) => {
      if (!editor.isEditable()) {
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      if (!TAB_TITLE_RESIZE_KEYS.has(event.key)) {
        return;
      }

      event.preventDefault();
      stopLexicalRootEvent(event);

      const metrics = getTabTitleResizeMetrics(tabIndex);
      if (!metrics) {
        return;
      }

      const activeResize = keyboardResizeStateRef.current;
      const isHeldRepeat = event.repeat && activeResize?.tabIndex === tabIndex;
      const currentWidth = isHeldRepeat && activeResize.widthPx !== null
        ? activeResize.widthPx
        : metrics.currentWidth;
      const currentPinnedWidth = isHeldRepeat
        ? activeResize.widthPx
        : tabData[tabIndex]?.pinnedWidthPx ?? null;
      let nextWidth: number | null | undefined;
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
        if (currentWidth >= metrics.maxWidth) {
          return;
        }
        nextWidth = Math.min(
          metrics.maxWidth,
          currentWidth + TAB_TITLE_KEYBOARD_STEP_PX
        );
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
        if (currentWidth <= metrics.minWidth) {
          return;
        }
        nextWidth = Math.max(
          metrics.minWidth,
          currentWidth - TAB_TITLE_KEYBOARD_STEP_PX
        );
      } else if (event.key === 'Home') {
        if (currentPinnedWidth === metrics.minWidth) {
          return;
        }
        nextWidth = metrics.minWidth;
      } else if (event.key === 'End') {
        if (currentPinnedWidth === metrics.maxWidth) {
          return;
        }
        nextWidth = metrics.maxWidth;
      } else if (
        event.key === 'Backspace' ||
        event.key === 'Delete' ||
        event.key === 'Enter' ||
        event.key === ' ' ||
        event.key === 'Spacebar'
      ) {
        if (currentPinnedWidth == null) {
          return;
        }
        nextWidth = null;
      }

      if (nextWidth === undefined) {
        return;
      }

      dragStateRef.current = null;
      setDragWidthState(null);
      setResizeDragActive(false);
      document.body.style.cursor = '';
      keyboardResizeStateRef.current = { tabIndex, widthPx: nextWidth };
      setDragWidthState({ tabIndex, widthPx: nextWidth });
    },
    [editor, getTabTitleResizeMetrics, tabData]
  );

  const commitKeyboardResize = useCallback(() => {
    const pendingResize = keyboardResizeStateRef.current;
    keyboardResizeStateRef.current = null;
    setDragWidthState(null);
    if (pendingResize) {
      commitTabWidthAtIndex(
        pendingResize.tabIndex,
        pendingResize.widthPx,
        HISTORY_PUSH_TAG
      );
    }
  }, [commitTabWidthAtIndex]);

  useEffect(() => {
    if (!resizeDragActive) {
      return undefined;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragStateRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      event.preventDefault();
      const deltaX = event.clientX - drag.startX;
      if (!drag.hasMoved && Math.abs(deltaX) < 1) {
        return;
      }
      drag.hasMoved = true;
      const nextWidth = Math.min(
        drag.groupContentWidth,
        Math.max(
          drag.minWidth,
          Math.round(drag.startWidth + deltaX)
        )
      );
      drag.nextWidth = nextWidth;
      setDragWidthState({ tabIndex: drag.tabIndex, widthPx: nextWidth });
    };

    const handlePointerEnd = (event: PointerEvent) => {
      const drag = dragStateRef.current;
      if (!drag || event.pointerId !== drag.pointerId) {
        return;
      }
      endTabResizeDrag();
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
    };
  }, [resizeDragActive, endTabResizeDrag]);

  useEffect(() => {
    return () => {
      if (dragStateRef.current) {
        dragStateRef.current = null;
        document.body.style.cursor = '';
      }
      keyboardResizeStateRef.current = null;
      if (reorderDragStateRef.current) {
        reorderDragStateRef.current = null;
        document.body.style.removeProperty('cursor');
        document.body.style.removeProperty('user-select');
      }
    };
  }, []);

  const getReorderTargetIndex = useCallback((clientX: number): number | null => {
    const tabs = Array.from(tabBarRef.current?.querySelectorAll<HTMLElement>('[data-tab-item="true"]') ?? []);
    if (tabs.length === 0) {
      return null;
    }
    for (let index = 0; index < tabs.length; index += 1) {
      const rect = tabs[index].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        return index;
      }
    }
    return tabs.length - 1;
  }, []);

  const reorderTab = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (fromIndex === toIndex) {
        return;
      }
      editor.update(
        () => {
          const node = $getNodeByKey(nodeKey);
          if (!$isTabGroupNode(node)) return;
          const panels = node.getTabPanels();
          if (
            fromIndex < 0 ||
            toIndex < 0 ||
            fromIndex >= panels.length ||
            toIndex >= panels.length
          ) {
            return;
          }

          const movedPanel = panels[fromIndex];
          const targetPanel = panels[toIndex];
          if (!movedPanel || !targetPanel || movedPanel === targetPanel) {
            return;
          }

          const currentWidths = node.getTabWidths();
          const nextWidths: (number | null)[] = [];
          for (let index = 0; index < panels.length; index += 1) {
            nextWidths[index] = currentWidths[index] ?? null;
          }
          const [movedWidth] = nextWidths.splice(fromIndex, 1);
          nextWidths.splice(toIndex, 0, movedWidth ?? null);

          if (fromIndex < toIndex) {
            targetPanel.insertAfter(movedPanel);
          } else {
            targetPanel.insertBefore(movedPanel);
          }

          node.setTabWidths(nextWidths.some((width) => width !== null) ? nextWidths : []);

          const activeIndex = node.getActiveIndex();
          let nextActiveIndex = activeIndex;
          if (activeIndex === fromIndex) {
            nextActiveIndex = toIndex;
          } else if (fromIndex < activeIndex && activeIndex <= toIndex) {
            nextActiveIndex = activeIndex - 1;
          } else if (toIndex <= activeIndex && activeIndex < fromIndex) {
            nextActiveIndex = activeIndex + 1;
          }
          node.setActiveIndex(nextActiveIndex);
        },
        { tag: 'tab-reorder' }
      );
    },
    [editor, nodeKey]
  );

  const endTabReorderDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = reorderDragStateRef.current;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    event.preventDefault();
    stopLexicalRootEvent(event);
    reorderDragStateRef.current = null;
    setDraggingTabKey(null);
    setDropTargetIndex(null);
    document.body.style.removeProperty('cursor');
    document.body.style.removeProperty('user-select');

    const totalDistance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    const hasDragged = drag.hasDragged || totalDistance >= 4;
    if (!hasDragged) {
      return;
    }
    skipNextTabClickRef.current = true;

    const targetIndex = getReorderTargetIndex(event.clientX);
    if (targetIndex !== null) {
      reorderTab(drag.fromIndex, targetIndex);
    }
  }, [getReorderTargetIndex, reorderTab]);

  const handleTabPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, tabKey: string, tabIndex: number) => {
      // moss-multi seam: read-only-tabs (T0.13): a read-only editor's tabs never reorder
      if (!editor.isEditable()) {
        return;
      }
      if ((event.button != null && event.button !== 0) || editingTabKey === tabKey) {
        return;
      }
      const target = event.target;
      if (
        target instanceof Element &&
        (
          target.closest('[data-tab-action]') ||
          target.closest('[data-tab-resize-handle]') ||
          target.closest('button') ||
          target.closest('input')
        )
      ) {
        return;
      }
      stopLexicalRootEvent(event);
      event.currentTarget.setPointerCapture?.(event.pointerId);
      reorderDragStateRef.current = {
        pointerId: event.pointerId,
        fromIndex: tabIndex,
        tabKey,
        startX: event.clientX,
        startY: event.clientY,
        hasDragged: false
      };
    },
    [editor, editingTabKey]
  );

  const handleTabPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = reorderDragStateRef.current;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.hasDragged && distance < 4) {
      return;
    }
    event.preventDefault();
    stopLexicalRootEvent(event);
    if (!drag.hasDragged) {
      drag.hasDragged = true;
      skipNextTabClickRef.current = true;
      setDraggingTabKey(drag.tabKey);
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
    }
    setDropTargetIndex(getReorderTargetIndex(event.clientX));
  }, [getReorderTargetIndex]);

  const startRename = useCallback(
    (tabKey: string, currentLabel: string) => {
      // moss-multi seam: read-only-tabs (T0.13): a read-only editor's tabs switch but never rename
      if (!editor.isEditable()) return;
      skipBlurCommitRef.current = false;
      outsideRenamePointerRef.current = false;
      pendingRenameFocusRef.current = { tabKey, label: currentLabel };
      setEditValue(currentLabel);
      setEditingTabKey(tabKey);
    },
    [editor]
  );

  const handleTitleTouchEnd = useCallback(
    (event: TouchEvent<HTMLSpanElement>, tabKey: string, label: string) => {
      const now = Date.now();
      const lastTap = lastTitleTapRef.current;

      if (lastTap?.tabKey === tabKey && now - lastTap.time <= 500) {
        event.preventDefault();
        event.stopPropagation();
        lastTitleTapRef.current = null;
        startRename(tabKey, label);
        return;
      }

      lastTitleTapRef.current = { tabKey, time: now };
    },
    [startRename]
  );

  const commitRename = useCallback((nextValue: string) => {
    if (!editingTabKey) return;
    skipBlurCommitRef.current = true;
    outsideRenamePointerRef.current = false;
    pendingRenameFocusRef.current = null;
    clearScheduledMenuRename();
    clearMenuRenameHandoff();
    const trimmed = nextValue.trim();
    if (trimmed) {
      editor.update(() => {
        const panel = $getNodeByKey(editingTabKey);
        if ($isTabPanelNode(panel)) {
          panel.setLabel(trimmed);
        }
      });
    }
    setEditingTabKey(null);
    setEditValue('');
  }, [editor, editingTabKey, clearScheduledMenuRename, clearMenuRenameHandoff]);

  const cancelRename = useCallback(() => {
    skipBlurCommitRef.current = true;
    outsideRenamePointerRef.current = false;
    pendingRenameFocusRef.current = null;
    clearScheduledMenuRename();
    clearMenuRenameHandoff();
    setEditingTabKey(null);
    setEditValue('');
  }, [clearScheduledMenuRename, clearMenuRenameHandoff]);

  const applyNativeRenameInput = useCallback((inputType: string, data: string | null) => {
    const input = inputRef.current;
    if (!input || !editingTabKey) {
      return;
    }

    const value = input.value;
    const selectionStart = input.selectionStart ?? value.length;
    const selectionEnd = input.selectionEnd ?? selectionStart;
    let replaceStart = Math.min(selectionStart, selectionEnd);
    let replaceEnd = Math.max(selectionStart, selectionEnd);
    let insertedText = data ?? '';

    if (inputType === 'deleteContentBackward') {
      if (replaceStart === replaceEnd && replaceStart > 0) {
        replaceStart -= 1;
      }
      insertedText = '';
    } else if (inputType === 'deleteContentForward') {
      if (replaceStart === replaceEnd && replaceEnd < value.length) {
        replaceEnd += 1;
      }
      insertedText = '';
    } else if (inputType.startsWith('delete')) {
      insertedText = '';
    } else if (!inputType.startsWith('insert')) {
      return;
    }

    const maxLength = input.maxLength > -1 ? input.maxLength : Number.POSITIVE_INFINITY;
    const availableLength = Math.max(0, maxLength - (value.length - (replaceEnd - replaceStart)));
    const nextInsertedText = insertedText.slice(0, availableLength);
    const nextValue =
      value.slice(0, replaceStart) + nextInsertedText + value.slice(replaceEnd);
    const nextSelection = replaceStart + nextInsertedText.length;

    input.value = nextValue;
    input.setSelectionRange(nextSelection, nextSelection);
    if (pendingRenameFocusRef.current?.tabKey === editingTabKey) {
      pendingRenameFocusRef.current = null;
    }
    setEditValue(nextValue);
  }, [editingTabKey]);

  const moveRenameInputSelection = useCallback((input: HTMLInputElement, key: string, shiftKey: boolean) => {
    const valueLength = input.value.length;
    const selectionStart = input.selectionStart ?? valueLength;
    const selectionEnd = input.selectionEnd ?? selectionStart;
    const collapsed = selectionStart === selectionEnd;
    let nextPosition: number;

    if (key === 'Home' || key === 'PageUp') {
      nextPosition = 0;
    } else if (key === 'End' || key === 'PageDown') {
      nextPosition = valueLength;
    } else if (key === 'ArrowLeft' || key === 'ArrowUp') {
      nextPosition = collapsed ? Math.max(0, selectionStart - 1) : selectionStart;
    } else {
      nextPosition = collapsed ? Math.min(valueLength, selectionEnd + 1) : selectionEnd;
    }

    if (!shiftKey) {
      input.setSelectionRange(nextPosition, nextPosition);
      return;
    }

    const anchor =
      input.selectionDirection === 'backward' ? selectionEnd : selectionStart;
    input.setSelectionRange(
      Math.min(anchor, nextPosition),
      Math.max(anchor, nextPosition),
      nextPosition < anchor ? 'backward' : 'forward'
    );
  }, []);

  const updateRenameInputRect = useCallback(() => {
    const anchor = renameAnchorRef.current;
    if (!anchor) {
      setRenameInputRect(null);
      return;
    }

    const rect = anchor.getBoundingClientRect();
    setRenameInputRect({
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height
    });
  }, []);

  useLayoutEffect(() => {
    if (!editingTabKey) {
      setRenameInputRect(null);
      return undefined;
    }

    updateRenameInputRect();
    const anchor = renameAnchorRef.current;
    const resizeObserver =
      anchor && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(updateRenameInputRect)
        : null;
    if (anchor) {
      resizeObserver?.observe(anchor);
    }
    window.addEventListener('resize', updateRenameInputRect);
    window.addEventListener('scroll', updateRenameInputRect, true);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateRenameInputRect);
      window.removeEventListener('scroll', updateRenameInputRect, true);
    };
  }, [editingTabKey, updateRenameInputRect]);

  useEffect(() => {
    if (!editingTabKey) {
      return undefined;
    }

    const root = editor.getRootElement();
    if (!root) {
      return undefined;
    }

    const getActiveRenameInput = (): HTMLInputElement | null => {
      const input = inputRef.current;
      if (
        input &&
        input.isConnected &&
        input.ownerDocument.activeElement === input
      ) {
        return input;
      }
      return null;
    };

    const isFromRenameInput = (event: Event, input: HTMLInputElement): boolean =>
      event.target instanceof Node && input.contains(event.target);

    const isCompositionBeforeInput = (event: InputEvent): boolean => {
      const inputType = event.inputType.toLowerCase();
      return event.isComposing || inputType.includes('composition');
    };

    const isComposingTextInput = (event: Event): boolean =>
      'isComposing' in event && Boolean((event as { isComposing?: boolean }).isComposing);

    const handleBeforeInput = (event: InputEvent) => {
      const input = getActiveRenameInput();
      if (!input || isFromRenameInput(event, input)) {
        return;
      }

      stopNativeEvent(event);
      if (isCompositionBeforeInput(event)) {
        return;
      }
      if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
        commitRename(input.value);
        return;
      }
      applyNativeRenameInput(event.inputType, event.data);
    };

    const handleTextInput = (event: Event) => {
      const input = getActiveRenameInput();
      if (!input || isFromRenameInput(event, input)) {
        return;
      }

      stopNativeEvent(event);
      if (isComposingTextInput(event)) {
        return;
      }
      applyNativeRenameInput('insertText', 'data' in event ? String(event.data ?? '') : '');
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const input = getActiveRenameInput();
      if (!input || isFromRenameInput(event, input)) {
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
        stopNativeEvent(event);
        input.setSelectionRange(0, input.value.length, 'forward');
        return;
      }

      if (event.key === 'Enter') {
        stopNativeEvent(event);
        commitRename(input.value);
        return;
      }
      if (event.key === 'Escape') {
        stopNativeEvent(event);
        cancelRename();
        return;
      }

      if (event.isComposing || event.key === 'Process' || event.key === 'Dead') {
        stopNativeEvent(event);
        return;
      }

      if (event.key === 'Backspace' || event.key === 'Delete') {
        stopNativeEvent(event);
        if (!event.metaKey && !event.ctrlKey && !event.altKey) {
          applyNativeRenameInput(
            event.key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward',
            null
          );
        }
        return;
      }

      if (RENAME_NAVIGATION_KEYS.has(event.key)) {
        stopNativeEvent(event);
        if (!event.metaKey && !event.ctrlKey && !event.altKey) {
          moveRenameInputSelection(input, event.key, event.shiftKey);
        }
        return;
      }

      const key = event.key.toLowerCase();
      const isEditingShortcut =
        (event.metaKey || event.ctrlKey) && RENAME_EDITING_SHORTCUT_KEYS.has(key);
      const isPrintableKey =
        !event.metaKey && !event.ctrlKey && !event.altKey && event.key.length === 1;

      if (isEditingShortcut || isPrintableKey) {
        stopNativeEvent(event);
      }
    };

    root.addEventListener('beforeinput', handleBeforeInput as EventListener, true);
    root.addEventListener('textInput', handleTextInput, true);
    root.addEventListener('keydown', handleKeyDown, true);
    return () => {
      root.removeEventListener('beforeinput', handleBeforeInput as EventListener, true);
      root.removeEventListener('textInput', handleTextInput, true);
      root.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [
    applyNativeRenameInput,
    cancelRename,
    commitRename,
    editor,
    editingTabKey,
    moveRenameInputSelection
  ]);

  useEffect(() => {
    if (!editingTabKey) {
      return undefined;
    }

    const handleDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        outsideRenamePointerRef.current = false;
        return;
      }

      const input = inputRef.current;
      outsideRenamePointerRef.current = !(
        input?.contains(target) ||
        optionsMenuRef.current?.contains(target) ||
        optionsButtonRef.current?.contains(target)
      );
    };

    document.addEventListener('pointerdown', handleDocumentPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
      outsideRenamePointerRef.current = false;
    };
  }, [editingTabKey]);

  const handleMenuRename = useCallback(
    (tabKey: string, currentLabel: string) => {
      clearScheduledMenuRename();
      flushSync(() => {
        closeOptionsMenu();
        startMenuRenameHandoff(tabKey, currentLabel);
        startRename(tabKey, currentLabel);
      });
    },
    [closeOptionsMenu, clearScheduledMenuRename, startMenuRenameHandoff, startRename]
  );

  const handleMenuKeepOnly = useCallback(
    (tabIndex: number) => {
      closeOptionsMenu();
      handleKeepOnly(tabIndex);
    },
    [closeOptionsMenu, handleKeepOnly]
  );

  const handleMenuRemoveTab = useCallback(
    (tabIndex: number) => {
      closeOptionsMenu();
      handleRemoveTab(tabIndex);
    },
    [closeOptionsMenu, handleRemoveTab]
  );

  const installNativeMenuListeners = useCallback(() => {
    const existingCleanup = nativeMenuCleanupRef.current;
    if (existingCleanup) {
      nativeMenuCleanupRef.current = null;
      existingCleanup();
    }

    const getActionButton = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Element)) {
        return null;
      }
      const actionButton = target.closest<HTMLElement>('[data-tab-action]');
      if (!actionButton) {
        return null;
      }

      const menu = optionsMenuRef.current;
      if (menu && !menu.contains(actionButton)) {
        return null;
      }
      return actionButton;
    };

    const getMenuActionButtons = (): HTMLElement[] => {
      return Array.from(
        optionsMenuRef.current?.querySelectorAll<HTMLElement>('[data-tab-action]') ?? []
      );
    };

    const isMenuKeyboardTarget = (target: EventTarget | null): boolean => {
      return (
        target instanceof Node &&
        (optionsMenuRef.current?.contains(target) === true ||
          optionsButtonRef.current?.contains(target) === true)
      );
    };

    const focusRelativeMenuAction = (event: KeyboardEvent, direction: 1 | -1) => {
      if (!isMenuKeyboardTarget(event.target)) {
        return;
      }
      const actionButtons = getMenuActionButtons();
      if (actionButtons.length === 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if ('stopImmediatePropagation' in event) {
        event.stopImmediatePropagation();
      }

      const currentAction = getActionButton(event.target);
      const currentIndex = currentAction ? actionButtons.indexOf(currentAction) : -1;
      const nextIndex =
        currentIndex === -1
          ? (direction === 1 ? 0 : actionButtons.length - 1)
          : (currentIndex + direction + actionButtons.length) % actionButtons.length;
      actionButtons[nextIndex]?.focus({ preventScroll: true });
    };

    const activateAction = (event: Event, actionButton: HTMLElement) => {
      const action = actionButton.dataset.tabAction;
      event.preventDefault();
      event.stopPropagation();
      if ('stopImmediatePropagation' in event) {
        event.stopImmediatePropagation();
      }

      if (action === 'rename') {
        const tabKey = actionButton.dataset.tabKey;
        const tabLabel = actionButton.dataset.tabLabel;
        if (tabKey && tabLabel !== undefined) {
          handleMenuRename(tabKey, tabLabel);
        }
        return;
      }

      const tabIndex = Number(actionButton.dataset.tabIndex);
      if (!Number.isInteger(tabIndex)) {
        return;
      }
      if (action === 'keep-only') {
        handleMenuKeepOnly(tabIndex);
      } else if (action === 'delete') {
        handleMenuRemoveTab(tabIndex);
      }
    };

    const handleNativeClick = (event: MouseEvent) => {
      const actionButton = getActionButton(event.target);
      if (actionButton) {
        activateAction(event, actionButton);
        return;
      }

      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (optionsMenuRef.current?.contains(target) || optionsButtonRef.current?.contains(target)) {
        return;
      }
      closeOptionsMenu();
    };

    const handleNativeKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeOptionsMenu();
        optionsButtonRef.current?.focus({ preventScroll: true });
        return;
      }
      if (event.key === 'ArrowDown') {
        focusRelativeMenuAction(event, 1);
        return;
      }
      if (event.key === 'ArrowUp') {
        focusRelativeMenuAction(event, -1);
        return;
      }
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      const actionButton = getActionButton(event.target);
      if (actionButton) {
        activateAction(event, actionButton);
      }
    };

    document.addEventListener('click', handleNativeClick, true);
    document.addEventListener('keydown', handleNativeKeyDown, true);

    nativeMenuCleanupRef.current = () => {
      document.removeEventListener('click', handleNativeClick, true);
      document.removeEventListener('keydown', handleNativeKeyDown, true);
    };
  }, [
    closeOptionsMenu,
    handleMenuRename,
    handleMenuKeepOnly,
    handleMenuRemoveTab
  ]);

  const toggleOptionsMenu = useCallback(
    (button: HTMLButtonElement, focusFirstItem = false) => {
      if (isOptionsMenuOpen) {
        closeOptionsMenu();
        return;
      }

      const rect = button.getBoundingClientRect();
      focusFirstMenuItemOnOpenRef.current = focusFirstItem;
      installNativeMenuListeners();
      setOptionsMenuPosition({
        top: rect.bottom + 4,
        left: rect.left
      });
      setIsOptionsMenuOpen(true);
    },
    [closeOptionsMenu, installNativeMenuListeners, isOptionsMenuOpen]
  );

  const editingTab = tabData.find((tab) => tab.key === editingTabKey) ?? null;
  const renameInputStyle = renameInputRect
    ? {
        position: 'fixed' as const,
        top: renameInputRect.top,
        left: renameInputRect.left,
        width: renameInputRect.width,
        height: renameInputRect.height,
        boxSizing: 'border-box' as const,
        zIndex: 1000
      }
    : {
        position: 'fixed' as const,
        width: 96,
        opacity: 0,
        pointerEvents: 'none' as const,
        zIndex: 1000
      };

  return (
    <>
      <div
        ref={tabBarRef}
        className="flex items-end gap-1 border-b border-border-subtle bg-surface-panel rounded-t-lg px-canvas-surface-pad pt-1"
        role="tablist"
        onPointerDown={stopLexicalRootEvent}
        onMouseDown={stopLexicalRootEvent}
        onClick={stopLexicalRootEvent}
        onDoubleClick={stopLexicalRootEvent}
        onTouchEnd={stopLexicalRootEvent}
      >
        {tabData.map((tab, index) => {
          const tabTitleMinWidthPx =
            tabTitleMinWidthsPx[index] ?? TAB_TITLE_MIN_WIDTH_PX;
          const titleWidthPx =
            dragWidthState?.tabIndex === index
              ? dragWidthState.widthPx
              : tab.pinnedWidthPx;
          const tabTitleMaxWidthPx = Math.max(
            tabTitleMinWidthPx,
            tabGroupWidthPx ?? titleWidthPx ?? tabTitleMinWidthPx
          );
          const effectiveTitleWidthPx = titleWidthPx == null
            ? null
            : Math.min(tabTitleMaxWidthPx, Math.max(tabTitleMinWidthPx, titleWidthPx));
          const accessibleTitleWidthPx = effectiveTitleWidthPx ?? Math.min(
            tabTitleMaxWidthPx,
            Math.max(
              tabTitleMinWidthPx,
              measuredTabTitleWidthsPx[index] ?? tabTitleMinWidthPx
            )
          );
          const hasPinnedTitleWidth = titleWidthPx != null;
          const isDraggingTab = draggingTabKey === tab.key;
          const isDropTarget = dropTargetIndex === index && draggingTabKey !== null && !isDraggingTab;
          const tabClassName = [
            'relative flex cursor-grab items-center gap-1 px-canvas-surface-pad py-1.5 text-sm active:cursor-grabbing',
            tab.isActive
              ? `-mb-px rounded-t-lg border border-b-0 border-border-subtle text-ink-default ${isDropTarget ? 'bg-accent-brand/5' : 'bg-surface-canvas'}`
              : `rounded-md ${isDropTarget ? 'bg-accent-brand/5 text-ink-default' : 'bg-surface-canvas text-ink-muted hover:bg-border-subtle/60 hover:text-ink-default'}`,
            isDraggingTab && 'opacity-60',
            isDropTarget && 'ring-1 ring-accent-brand/15'
          ].filter(Boolean).join(' ');

          return (
            <Fragment key={tab.key}>
            <div
              data-tab-item="true"
              role="tab"
              aria-selected={tab.isActive}
              tabIndex={tab.isActive ? 0 : -1}
              className={tabClassName}
              data-tab-dragging={isDraggingTab ? 'true' : undefined}
              data-tab-drop-target={isDropTarget ? 'true' : undefined}
              onPointerDown={(event) => handleTabPointerDown(event, tab.key, index)}
              onPointerMove={handleTabPointerMove}
              onPointerUp={endTabReorderDrag}
              onPointerCancel={endTabReorderDrag}
              onLostPointerCapture={endTabReorderDrag}
              onClick={(event) => {
                if (skipNextTabClickRef.current) {
                  skipNextTabClickRef.current = false;
                  event.preventDefault();
                  stopLexicalRootEvent(event);
                  return;
                }
                if (!tab.isActive && editingTabKey !== tab.key) handleTabClick(index);
              }}
            >
            {editingTabKey === tab.key ? (
              <span
                ref={renameAnchorRef}
                aria-hidden="true"
                className="invisible box-border inline-block h-5 min-w-0 overflow-hidden whitespace-nowrap rounded-md border border-border-clear py-0.5 pl-1.5 pr-1 text-small leading-none"
                style={{
                  flex: hasPinnedTitleWidth
                    ? `0 0 ${accessibleTitleWidthPx}px`
                    : '0 1 auto',
                  width: hasPinnedTitleWidth ? `${accessibleTitleWidthPx}px` : 'max-content',
                  minWidth: hasPinnedTitleWidth
                    ? `${accessibleTitleWidthPx}px`
                    : `${TAB_TITLE_MIN_WIDTH_PX}px`,
                  maxWidth: hasPinnedTitleWidth
                    ? `${accessibleTitleWidthPx}px`
                    : 'var(--moss-tab-title-max)'
                }}
              >
                {editValue || '\u00a0'}
              </span>
            ) : (
              <span
                data-tab-title
                className="truncate rounded-sm px-1 -mx-1 cursor-grab transition-colors hover:bg-border-subtle/60 hover:text-ink-default active:cursor-grabbing"
                style={{
                  flex: effectiveTitleWidthPx != null ? `0 0 ${effectiveTitleWidthPx}px` : undefined,
                  width: effectiveTitleWidthPx != null ? `${effectiveTitleWidthPx}px` : undefined,
                  maxWidth: effectiveTitleWidthPx != null ? `${effectiveTitleWidthPx}px` : 'var(--moss-tab-title-max)'
                }}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  startRename(tab.key, tab.label);
                }}
                onTouchEnd={(event) => handleTitleTouchEnd(event, tab.key, tab.label)}
              >
                {tab.label}
              </span>
            )}

            {/* moss-multi seam: read-only-tabs (T0.13): no tab options (rename, keep only, delete) when read-only */}
            {tab.isActive && isEditorEditable && (
              <>
                <div className="relative ml-1 flex h-5 w-5 items-center justify-center">
                  <button
                    ref={optionsButtonRef}
                    type="button"
                    className="flex h-5 w-5 items-center justify-center rounded text-ink-muted hover:bg-border-subtle hover:text-ink-default"
                    aria-label="Tab options"
                    aria-haspopup="menu"
                    aria-expanded={isOptionsMenuOpen}
                    onPointerDown={stopLexicalRootEvent}
                    onMouseDown={stopLexicalRootEvent}
                    onClick={(event) => {
                      stopLexicalRootEvent(event);
                      toggleOptionsMenu(event.currentTarget);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        stopLexicalRootEvent(event);
                        closeOptionsMenu();
                        return;
                      }
                      if (event.key !== 'Enter' && event.key !== ' ') {
                        return;
                      }
                      event.preventDefault();
                      stopLexicalRootEvent(event);
                      toggleOptionsMenu(event.currentTarget, true);
                    }}
                  >
                    <MoreVertical size={14} />
                  </button>
                </div>
                {isOptionsMenuOpen && optionsMenuPosition
                  ? createPortal(
                      <div
                        ref={optionsMenuRef}
                        role="menu"
                        aria-label="Tab options"
                        className={TAB_OPTIONS_MENU_CLASS}
                        style={{
                          position: 'fixed',
                          top: optionsMenuPosition.top,
                          left: optionsMenuPosition.left
                        }}
                        onClick={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                          if (event.key !== 'Escape') {
                            return;
                          }
                          event.preventDefault();
                          event.stopPropagation();
                          closeOptionsMenu();
                          optionsButtonRef.current?.focus({ preventScroll: true });
                        }}
                      >
                        <button
                          type="button"
                          role="menuitem"
                          data-tab-action="rename"
                          data-tab-key={tab.key}
                          data-tab-label={tab.label}
                          className={TAB_OPTIONS_MENU_ITEM_CLASS}
                        >
                          <PenLine size={14} className="mr-2" />
                          Rename
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          data-tab-action="keep-only"
                          data-tab-index={index}
                          className={TAB_OPTIONS_MENU_ITEM_CLASS}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleMenuKeepOnly(index);
                          }}
                        >
                          <CopyMinus size={14} className="mr-2" />
                          Keep this tab only
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          data-tab-action="delete"
                          data-tab-index={index}
                          className={`${TAB_OPTIONS_MENU_ITEM_CLASS} text-accent-terracotta`}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleMenuRemoveTab(index);
                          }}
                        >
                          <Trash2 size={14} className="mr-2" />
                          Delete
                        </button>
                      </div>,
                      document.body
                    )
                  : null}
              </>
            )}
            </div>
            {index < tabData.length - 1 && (
              <div
                role="separator"
                tabIndex={isEditorEditable ? 0 : -1}
                aria-disabled={isEditorEditable ? undefined : true}
                aria-orientation="vertical"
                aria-label={`Resize ${tab.label} tab title`}
                aria-valuemin={tabTitleMinWidthPx}
                aria-valuemax={tabTitleMaxWidthPx}
                aria-valuenow={accessibleTitleWidthPx}
                aria-valuetext={
                  effectiveTitleWidthPx == null
                    ? `Automatic width, ${accessibleTitleWidthPx} pixels`
                    : `${effectiveTitleWidthPx} pixels`
                }
                data-tab-resize-handle="true"
                className={`-mx-1 flex shrink-0 touch-none select-none items-center self-stretch rounded-sm ${
                  isEditorEditable
                    ? 'cursor-col-resize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-brand forced-colors:focus-visible:outline forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-offset-2'
                    : 'cursor-default'
                }`}
                style={{ width: TAB_RESIZE_HANDLE_WIDTH_PX }}
                onPointerDown={(event) => handleResizeHandlePointerDown(event, index)}
                onDoubleClick={(event) => handleResizeHandleDoubleClick(event, index)}
                onFocus={() => getTabTitleResizeMetrics(index)}
                onKeyDown={(event) => handleResizeHandleKeyDown(event, index)}
                onKeyUp={commitKeyboardResize}
                onBlur={commitKeyboardResize}
                onClick={stopLexicalRootEvent}
                onMouseDown={stopLexicalRootEvent}
              >
                <span className="pointer-events-none mx-auto h-3.5 w-px rounded-full bg-border-default" />
              </div>
            )}
            </Fragment>
          );
        })}

        {/* moss-multi seam: read-only-tabs (T0.13): no Add tab when read-only */}
        {isEditorEditable && (
        <button
          className="mb-px flex h-7 w-7 items-center justify-center rounded text-ink-muted hover:bg-border-subtle hover:text-ink-default"
          onClick={handleAddTab}
          aria-label="Add tab"
        >
          <Plus size={16} />
        </button>
        )}
      </div>
      {editingTab
        ? createPortal(
            <input
              ref={inputRef}
              aria-label={`Rename ${editingTab.label}`}
              className="box-border h-5 w-24 select-text rounded-md border border-border-clear bg-surface-transparent py-0.5 pl-1.5 pr-1 text-small leading-none text-ink-default outline-none placeholder:text-ink-faint/50 transition-colors hover:bg-surface-panel focus:border-border-subtle focus:bg-surface-panel"
              data-focus-guard="active"
              style={renameInputStyle}
              value={editValue}
              maxLength={24}
              onChange={(event) => {
                const nextValue = event.target.value;
                setEditValue(nextValue);
                if (pendingRenameFocusRef.current?.tabKey === editingTabKey) {
                  pendingRenameFocusRef.current = null;
                }
              }}
              onPointerDown={(e) => {
                stopLexicalRootEvent(e);
                clearMenuRenameHandoffForInputInteraction();
              }}
              onMouseDown={(e) => {
                stopLexicalRootEvent(e);
                clearMenuRenameHandoffForInputInteraction();
              }}
              onClick={stopLexicalRootEvent}
              onDoubleClick={stopLexicalRootEvent}
              onFocus={(event) => {
                const pendingRename = pendingRenameFocusRef.current;
                if (
                  pendingRename &&
                  pendingRename.tabKey === editingTabKey &&
                  event.currentTarget.value === pendingRename.label
                ) {
                  event.currentTarget.setSelectionRange(0, pendingRename.label.length, 'forward');
                }
              }}
              onKeyDown={(e) => {
                stopLexicalRootEvent(e);
                const keepsMenuRenameHandoff =
                  !e.altKey &&
                  !e.ctrlKey &&
                  !e.metaKey &&
                  (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete');
                if (!keepsMenuRenameHandoff) {
                  clearMenuRenameHandoffForInputInteraction();
                }
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitRename(e.currentTarget.value);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelRename();
                }
              }}
              onBlur={(event) => {
                const handoff = menuRenameHandoffRef.current;
                const isOutsidePointerBlur = outsideRenamePointerRef.current;
                outsideRenamePointerRef.current = false;
                if (
                  handoff &&
                  handoff.tabKey === editingTabKey
                ) {
                  if (isOutsidePointerBlur) {
                    clearMenuRenameHandoff();
                    commitRename(event.currentTarget.value);
                    return;
                  }
                  if (event.currentTarget.value === handoff.label) {
                    focusRenameInput(handoff.label);
                    refocusMenuRenameInput(handoff.tabKey, handoff.label);
                  } else {
                    const selection = {
                      start: event.currentTarget.selectionStart,
                      end: event.currentTarget.selectionEnd,
                      direction: event.currentTarget.selectionDirection
                    };
                    focusRenameInputPreservingSelection(
                      selection.start,
                      selection.end,
                      selection.direction
                    );
                    refocusMenuRenameInput(handoff.tabKey, handoff.label, selection);
                  }
                  return;
                }
                if (
                  pendingRenameFocusRef.current?.tabKey === editingTabKey
                ) {
                  return;
                }
                if (skipBlurCommitRef.current) {
                  skipBlurCommitRef.current = false;
                  return;
                }
                commitRename(event.currentTarget.value);
              }}
            />,
            document.body
          )
        : null}
    </>
  );
}

// ── Plugin ───────────────────────────────────────────────────────────────

export function TabBarPlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const [groups, setGroups] = useState<TabGroupInfo[]>([]);
  const tabBarSlotsRef = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    const rebuildGroups = () => {
      const newGroups: TabGroupInfo[] = [];
      for (const [key, tabBarElement] of tabBarSlotsRef.current) {
        if (tabBarElement.isConnected) {
          newGroups.push({ key, tabBarElement });
        }
      }
      setGroups(newGroups);
    };

    const unregisterGroup = editor.registerMutationListener(
      TabGroupNode,
      (mutations: Map<string, NodeMutation>) => {
        let needsFlush = false;

        for (const [nodeKey, mutation] of mutations) {
          if (mutation === 'destroyed') {
            tabBarSlotsRef.current.delete(nodeKey);
            needsFlush = true;
            continue;
          }

          // 'created' or 'updated'
          const groupDom = editor.getElementByKey(nodeKey);
          if (!groupDom) continue;
          const tabBar = groupDom.querySelector('.moss-tab-bar') as HTMLElement | null;
          if (!tabBar) continue;
          tabBarSlotsRef.current.set(nodeKey, tabBar);
        }

        if (needsFlush) {
          // Use flushSync to unmount portals synchronously before Lexical
          // finishes removing the DOM elements they're attached to.
          flushSync(() => rebuildGroups());
        } else {
          rebuildGroups();
        }
      }
    );

    return unregisterGroup;
  }, [editor]);

  return (
    <>
      {groups.map((group) =>
        group.tabBarElement.isConnected
          ? createPortal(
              <TabBar nodeKey={group.key} editor={editor} />,
              group.tabBarElement
            )
          : null
      )}
    </>
  );
}

export default TabBarPlugin;
