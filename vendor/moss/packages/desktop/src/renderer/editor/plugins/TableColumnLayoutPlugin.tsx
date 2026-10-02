// ported-from: packages/desktop/src/renderer/editor/plugins/TableColumnLayoutPlugin.tsx @ 762abb777
import { useCallback, useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $isTableNode, TableNode } from '@lexical/table';
import { $getNearestNodeFromDOMNode } from 'lexical';

type ColumnKind = 'narrow' | 'medium' | 'wide' | 'prose';

const MAX_SAMPLED_BODY_ROWS = 8;
const PROSE_HEADER_RE =
  /\b(description|details?|summary|notes?|context|analysis|comment|takeaways?|overview)\b/i;
const WIDE_HEADER_RE =
  /\b(url|link|path|file|repo|branch|command|query|source|reference|slug)\b/i;
const NARROW_HEADER_RE =
  /\b(status|state|date|time|due|eta|priority|type|stage|id|count|qty|score|rank|amount|price|cost|percent|pct|%)\b/i;
const BOOLEAN_OR_STATUS_RE =
  /^(?:yes|no|true|false|done|todo|blocked|open|closed|draft|ready|complete|completed|active|pending|high|medium|low|p[0-3]|n\/a|none|tbd)$/i;
const DATE_TIME_RE =
  /^(?:(?:mon|tue|wed|thu|fri|sat|sun)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}:\d{2}(?:\s?[ap]m)?)/i;
const NUMERIC_RE = /^[\$€£¥]?\s*-?\d[\d,.]*(?:%|[kmb])?$/i;
const URLISH_RE = /https?:\/\/|www\.|[/\\]|[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+/;
const CODEISH_RE = /[`{}[\]<>_=]/;
const PIXEL_WIDTH_RE = /^\d+(?:\.\d+)?px$/;
const TABLE_SCROLL_SHELL_CLASS = 'moss-table-scroll-shell';
const TABLE_SCROLL_VIEWPORT_CLASS = 'moss-table-scroll-viewport';
const TABLE_SCROLL_EPSILON_PX = 1;

// Keep inferred columns at the same minimum width enforced by the column
// resizer. Compact tables still fill their container; only tables whose column
// floor exceeds the available width become horizontally scrollable.
export const TABLE_MIN_COLUMN_WIDTH_PX = 72;

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value));
};

const normalizeCellText = (cell: HTMLTableCellElement | undefined): string => {
  return (cell?.textContent ?? '').replace(/\s+/g, ' ').trim();
};

const inferCellKind = (text: string): ColumnKind => {
  if (!text) {
    return 'medium';
  }

  if (BOOLEAN_OR_STATUS_RE.test(text) || DATE_TIME_RE.test(text) || NUMERIC_RE.test(text)) {
    return 'narrow';
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 7 || text.length >= 48) {
    return 'prose';
  }

  if (URLISH_RE.test(text) || CODEISH_RE.test(text) || text.length >= 24) {
    return 'wide';
  }

  return 'medium';
};

const inferColumnKind = (headerText: string, samples: string[]): ColumnKind => {
  if (PROSE_HEADER_RE.test(headerText)) {
    return 'prose';
  }
  if (WIDE_HEADER_RE.test(headerText)) {
    return 'wide';
  }
  if (NARROW_HEADER_RE.test(headerText)) {
    return 'narrow';
  }

  const nonEmptySamples = samples.filter(Boolean);
  if (nonEmptySamples.length === 0) {
    return headerText.length >= 20 ? 'wide' : 'medium';
  }

  let narrowCount = 0;
  let wideCount = 0;
  let proseCount = 0;
  let totalLength = 0;

  for (const sample of nonEmptySamples) {
    const kind = inferCellKind(sample);
    totalLength += sample.length;
    if (kind === 'narrow') narrowCount += 1;
    if (kind === 'wide') wideCount += 1;
    if (kind === 'prose') proseCount += 1;
  }

  const averageLength = totalLength / nonEmptySamples.length;
  if (proseCount >= Math.max(1, Math.ceil(nonEmptySamples.length / 3)) || averageLength >= 30) {
    return 'prose';
  }
  if (narrowCount === nonEmptySamples.length) {
    return 'narrow';
  }
  if (wideCount >= Math.max(1, Math.ceil(nonEmptySamples.length / 3)) || averageLength >= 18) {
    return 'wide';
  }

  return 'medium';
};

const buildColumnWeights = (table: HTMLTableElement): number[] => {
  const rows = Array.from(table.rows);
  if (rows.length === 0) {
    return [];
  }

  const headerRow =
    rows.find((row) =>
      Array.from(row.cells).some(
        (cell) =>
          cell.tagName === 'TH' || cell.classList.contains('moss-table-cell-header')
      )
    ) ?? rows[0];

  const bodyRows = rows.filter((row) => row !== headerRow).slice(0, MAX_SAMPLED_BODY_ROWS);
  const columnCount = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);

  return Array.from({ length: columnCount }, (_, columnIndex) => {
    const headerText = normalizeCellText(headerRow.cells[columnIndex]);
    const samples = bodyRows.map((row) => normalizeCellText(row.cells[columnIndex]));
    const kind = inferColumnKind(headerText, samples);
    const averageSampleLength =
      samples.filter(Boolean).reduce((sum, sample) => sum + sample.length, 0) /
      Math.max(1, samples.filter(Boolean).length);

    let weight =
      kind === 'narrow' ? 1 : kind === 'medium' ? 1.5 : kind === 'wide' ? 2.15 : 3.25;

    if (headerText.length >= 16 && kind !== 'narrow') {
      weight += 0.15;
    }
    if (averageSampleLength >= 24 && kind === 'medium') {
      weight += 0.25;
    }
    if (averageSampleLength >= 36 && kind === 'wide') {
      weight += 0.2;
    }

    return weight;
  });
};

const normalizeClampedShares = (weights: number[]): number[] => {
  if (weights.length === 0) {
    return [];
  }

  const evenShare = 100 / weights.length;
  const minShare = Math.min(evenShare, clamp(evenShare * 0.55, 6, 12));
  const maxShare = Math.max(clamp(evenShare * 2.35, 22, 42), minShare + 6);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const desired =
    totalWeight > 0
      ? weights.map((weight) => (weight / totalWeight) * 100)
      : weights.map(() => evenShare);

  const shares = [...desired];
  const locked = new Set<number>();

  while (true) {
    let changed = false;

    for (let index = 0; index < shares.length; index += 1) {
      if (locked.has(index)) {
        continue;
      }

      if (shares[index] < minShare) {
        shares[index] = minShare;
        locked.add(index);
        changed = true;
      } else if (shares[index] > maxShare) {
        shares[index] = maxShare;
        locked.add(index);
        changed = true;
      }
    }

    if (!changed) {
      break;
    }

    if (locked.size === shares.length) {
      return shares.map(() => evenShare);
    }

    const lockedTotal = shares.reduce(
      (sum, share, index) => sum + (locked.has(index) ? share : 0),
      0
    );
    const unlockedIndices = shares
      .map((_, index) => index)
      .filter((index) => !locked.has(index));
    const unlockedDesiredTotal = unlockedIndices.reduce(
      (sum, index) => sum + desired[index],
      0
    );
    const remaining = Math.max(0, 100 - lockedTotal);

    if (unlockedDesiredTotal <= 0) {
      const fallbackShare = remaining / unlockedIndices.length;
      for (const index of unlockedIndices) {
        shares[index] = fallbackShare;
      }
      break;
    }

    for (const index of unlockedIndices) {
      shares[index] = (desired[index] / unlockedDesiredTotal) * remaining;
    }
  }

  // Round with the largest-remainder method instead of placing the accumulated
  // correction on the final column. Increase precision for broad tables so
  // every emitted share stays positive and its 72px floor remains close to the
  // ideal columnCount * 72px table width.
  const decimalPlaces = Math.max(2, Math.ceil(Math.log10(shares.length)));
  const unitsPerPercent = 10 ** decimalPlaces;
  const totalUnits = 100 * unitsPerPercent;
  const exactUnits = shares.map((share) => share * unitsPerPercent);
  const roundedUnits = exactUnits.map((share) => Math.floor(share));
  const remainingUnits = totalUnits - roundedUnits.reduce((sum, share) => sum + share, 0);
  const indicesByRemainder = exactUnits
    .map((share, index) => ({ index, remainder: share - roundedUnits[index] }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);

  for (let offset = 0; offset < remainingUnits; offset += 1) {
    roundedUnits[indicesByRemainder[offset].index] += 1;
  }

  return roundedUnits.map((share) => share / unitsPerPercent);
};

const getInferredTableMinWidth = (shares: number[]): number => {
  if (shares.length === 0) {
    return 0;
  }

  const evenShare = 100 / shares.length;
  return Math.ceil(
    shares.reduce((minWidth, share) => {
      const normalizedShare = share > 0 ? share : evenShare;
      return Math.max(minWidth, (TABLE_MIN_COLUMN_WIDTH_PX * 100) / normalizedShare);
    }, shares.length * TABLE_MIN_COLUMN_WIDTH_PX)
  );
};

const ensureColGroup = (
  table: HTMLTableElement,
  columnCount: number
): HTMLTableColElement[] => {
  let colGroup = table.querySelector('colgroup');
  if (!colGroup) {
    colGroup = document.createElement('colgroup');
    table.insertBefore(colGroup, table.firstChild);
  }

  while (colGroup.children.length < columnCount) {
    colGroup.appendChild(document.createElement('col'));
  }

  while (colGroup.children.length > columnCount) {
    colGroup.lastElementChild?.remove();
  }

  return Array.from(colGroup.children).filter(
    (child): child is HTMLTableColElement => child instanceof HTMLTableColElement
  );
};

export const tableHasExplicitPixelColumnWidths = (table: HTMLTableElement): boolean => {
  const columns = Array.from(table.querySelectorAll(':scope > colgroup > col')).filter(
    (candidate): candidate is HTMLTableColElement => candidate instanceof HTMLTableColElement
  );

  return columns.length > 0 && columns.every((column) => PIXEL_WIDTH_RE.test(column.style.width.trim()));
};

// Manually-resized tables persist explicit pixel column widths. Their sum is
// the intended table width, so outside-edge resizing can make the table either
// narrower than its container or wide enough to scroll without redistributing
// its columns. This only touches rendered styles — persisted layout metadata
// remains unchanged.
export const applyIntendedPixelColumnWidths = (
  table: HTMLTableElement,
  intendedColWidths: readonly number[] | null
): void => {
  const columns = Array.from(table.querySelectorAll(':scope > colgroup > col')).filter(
    (candidate): candidate is HTMLTableColElement => candidate instanceof HTMLTableColElement
  );
  if (columns.length === 0) {
    return;
  }

  const intended =
    intendedColWidths && intendedColWidths.length === columns.length
      ? intendedColWidths
      : columns.map((column) => parseFloat(column.style.width) || 0);
  const intendedTotal = intended.reduce((sum, width) => sum + width, 0);
  if (intendedTotal <= 0) {
    return;
  }

  const tableWidth = `${Math.ceil(intendedTotal)}px`;
  table.style.width = tableWidth;
  table.style.minWidth = tableWidth;
  table.style.tableLayout = 'fixed';

  columns.forEach((column, index) => {
    const width = `${Math.round(intended[index])}px`;
    if (column.style.width !== width) {
      column.style.width = width;
    }
  });
};

const balanceTableElement = (
  table: HTMLTableElement,
  intendedColWidths: readonly number[] | null
): void => {
  if (tableHasExplicitPixelColumnWidths(table)) {
    applyIntendedPixelColumnWidths(table, intendedColWidths);
    return;
  }

  const rows = Array.from(table.rows);
  const columnCount = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
  if (columnCount === 0) {
    return;
  }

  const shares = normalizeClampedShares(buildColumnWeights(table));
  const columns = ensureColGroup(table, columnCount);
  table.style.width = '100%';
  table.style.minWidth = `${getInferredTableMinWidth(shares)}px`;
  table.style.tableLayout = 'fixed';

  columns.forEach((column, index) => {
    const width = `${shares[index] ?? Number((100 / columnCount).toFixed(2))}%`;
    if (column.style.width !== width) {
      column.style.width = width;
    }
  });
};

type TableScrollElements = {
  shell: HTMLElement;
  viewport: HTMLElement;
};

const getTableScrollElements = (table: HTMLTableElement): TableScrollElements | null => {
  const shell = table.closest(`.${TABLE_SCROLL_SHELL_CLASS}`);
  if (!(shell instanceof HTMLElement)) {
    return null;
  }

  if (!shell.classList.contains(TABLE_SCROLL_VIEWPORT_CLASS)) {
    return null;
  }

  return { shell, viewport: shell };
};

export const updateTableOverflowState = (table: HTMLTableElement): void => {
  const elements = getTableScrollElements(table);
  if (!elements) {
    return;
  }

  const { shell, viewport } = elements;
  const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  const hasOverflow = maxScrollLeft > TABLE_SCROLL_EPSILON_PX;
  const isAtStart = !hasOverflow || viewport.scrollLeft <= TABLE_SCROLL_EPSILON_PX;
  const isAtEnd = !hasOverflow ||
    viewport.scrollLeft >= maxScrollLeft - TABLE_SCROLL_EPSILON_PX;

  shell.dataset.tableOverflow = String(hasOverflow);
  shell.dataset.tableScrollStart = String(isAtStart);
  shell.dataset.tableScrollEnd = String(isAtEnd);

  if (hasOverflow) {
    viewport.tabIndex = 0;
    viewport.setAttribute('role', 'region');
    viewport.setAttribute('aria-label', 'Scrollable table');
  } else {
    viewport.removeAttribute('tabindex');
    viewport.removeAttribute('role');
    viewport.removeAttribute('aria-label');
  }
};

export const handleTableOverflowKeyDown = (event: KeyboardEvent): boolean => {
  const viewport = event.target;
  if (!(viewport instanceof HTMLElement) ||
      !viewport.classList.contains(TABLE_SCROLL_VIEWPORT_CLASS) ||
      viewport.dataset.tableOverflow !== 'true' ||
      event.altKey || event.ctrlKey || event.metaKey) {
    return false;
  }

  const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
  let nextScrollLeft: number | null = null;

  if (event.key === 'ArrowLeft') {
    nextScrollLeft = viewport.scrollLeft - TABLE_MIN_COLUMN_WIDTH_PX;
  } else if (event.key === 'ArrowRight') {
    nextScrollLeft = viewport.scrollLeft + TABLE_MIN_COLUMN_WIDTH_PX;
  } else if (event.key === 'Home') {
    nextScrollLeft = 0;
  } else if (event.key === 'End') {
    nextScrollLeft = maxScrollLeft;
  }

  if (nextScrollLeft === null) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();
  viewport.scrollLeft = clamp(nextScrollLeft, 0, maxScrollLeft);

  const table = viewport.querySelector('table.moss-table');
  if (table instanceof HTMLTableElement) {
    updateTableOverflowState(table);
  }
  return true;
};

const closestTableFromNode = (node: Node | null): HTMLTableElement | null => {
  if (!node) {
    return null;
  }

  if (node instanceof HTMLTableElement) {
    return node;
  }

  const element = node instanceof Element ? node : node.parentElement;
  if (!element) {
    return null;
  }

  const ancestorTable = element.closest('table.moss-table');
  if (ancestorTable instanceof HTMLTableElement) {
    return ancestorTable;
  }

  const descendantTable = element.querySelector('table.moss-table');
  return descendantTable instanceof HTMLTableElement ? descendantTable : null;
};

const collectTablesFromAddedNodes = (nodes: NodeList): HTMLTableElement[] => {
  const tables: HTMLTableElement[] = [];
  nodes.forEach((node) => {
    const table = closestTableFromNode(node);
    if (table) {
      tables.push(table);
      return;
    }

    if (node instanceof Element) {
      tables.push(
        ...Array.from(node.querySelectorAll('table.moss-table')).filter(
          (candidate): candidate is HTMLTableElement => candidate instanceof HTMLTableElement
        )
      );
    }
  });
  return tables;
};

export function TableColumnLayoutPlugin(): null {
  const [editor] = useLexicalComposerContext();
  const rootElementRef = useRef<HTMLElement | null>(null);
  const scheduledTablesRef = useRef(new Set<HTMLTableElement>());
  const scheduledAllTablesRef = useRef(false);
  const animationFrameRef = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const observedResizeTargetsRef = useRef(new Set<Element>());

  const observeResizeTarget = useCallback((target: Element) => {
    const resizeObserver = resizeObserverRef.current;
    if (!resizeObserver || observedResizeTargetsRef.current.has(target)) {
      return;
    }

    resizeObserver.observe(target);
    observedResizeTargetsRef.current.add(target);
  }, []);

  const unobserveDetachedResizeTargets = useCallback(() => {
    const resizeObserver = resizeObserverRef.current;
    const rootElement = rootElementRef.current;
    if (!resizeObserver || !rootElement) {
      return;
    }

    for (const target of observedResizeTargetsRef.current) {
      const isEmptyViewport =
        target instanceof HTMLElement &&
        target.classList.contains(TABLE_SCROLL_VIEWPORT_CLASS) &&
        !target.querySelector('table.moss-table');
      if (!rootElement.contains(target) || isEmptyViewport) {
        resizeObserver.unobserve(target);
        observedResizeTargetsRef.current.delete(target);
      }
    }
  }, []);

  const flushScheduledLayouts = useCallback(() => {
    animationFrameRef.current = null;
    const rootElement = rootElementRef.current;
    if (!rootElement) {
      scheduledTablesRef.current.clear();
      scheduledAllTablesRef.current = false;
      return;
    }

    const tables = scheduledAllTablesRef.current
      ? Array.from(rootElement.querySelectorAll('table.moss-table')).filter(
          (candidate): candidate is HTMLTableElement => candidate instanceof HTMLTableElement
        )
      : Array.from(scheduledTablesRef.current).filter((table) => table.isConnected);

    scheduledTablesRef.current.clear();
    scheduledAllTablesRef.current = false;

    // Read persisted column-width intent without mutating layout metadata.
    const intendedWidthsByTable = new Map<HTMLTableElement, readonly number[] | null>();
    editor.getEditorState().read(
      () => {
        for (const table of tables) {
          const node = $getNearestNodeFromDOMNode(table);
          intendedWidthsByTable.set(table, $isTableNode(node) ? node.getColWidths() ?? null : null);
        }
      },
      { editor }
    );

    for (const table of tables) {
      balanceTableElement(table, intendedWidthsByTable.get(table) ?? null);
      updateTableOverflowState(table);
      const scrollElements = getTableScrollElements(table);
      observeResizeTarget(table);
      if (scrollElements) {
        observeResizeTarget(scrollElements.viewport);
      }
    }
  }, [editor, observeResizeTarget]);

  const scheduleLayoutFlush = useCallback(() => {
    if (animationFrameRef.current !== null) {
      return;
    }

    animationFrameRef.current = requestAnimationFrame(flushScheduledLayouts);
  }, [flushScheduledLayouts]);

  const scheduleTableLayout = useCallback(
    (table: HTMLTableElement | null) => {
      if (!table || !table.isConnected) {
        return;
      }

      scheduledTablesRef.current.add(table);
      scheduleLayoutFlush();
    },
    [scheduleLayoutFlush]
  );

  const scheduleAllTableLayouts = useCallback(() => {
    scheduledAllTablesRef.current = true;
    scheduleLayoutFlush();
  }, [scheduleLayoutFlush]);

  useEffect(() => {
    let mutationObserver: MutationObserver | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let observedRootElement: HTMLElement | null = null;

    const handleScroll = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement) ||
          !target.classList.contains(TABLE_SCROLL_VIEWPORT_CLASS)) {
        return;
      }

      const table = target.querySelector('table.moss-table');
      if (table instanceof HTMLTableElement) {
        updateTableOverflowState(table);
      }
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      handleTableOverflowKeyDown(event);
    };

    const disconnectRootObservers = (): void => {
      observedRootElement?.removeEventListener('scroll', handleScroll, true);
      observedRootElement?.removeEventListener('keydown', handleKeyDown, true);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      observedResizeTargetsRef.current.clear();
      mutationObserver = null;
      resizeObserver = null;
      resizeObserverRef.current = null;
      observedRootElement = null;
      rootElementRef.current = null;
    };

    const connectRootObservers = (rootElement: HTMLElement | null): void => {
      disconnectRootObservers();
      if (!rootElement) {
        return;
      }

      rootElementRef.current = rootElement;
      observedRootElement = rootElement;
      rootElement.addEventListener('scroll', handleScroll, { capture: true, passive: true });
      rootElement.addEventListener('keydown', handleKeyDown, true);

      mutationObserver = new MutationObserver((mutations) => {
        let shouldScheduleAll = false;
        let removedNodes = false;

        for (const mutation of mutations) {
          if (mutation.type === 'childList' && mutation.removedNodes.length > 0) {
            removedNodes = true;
          }

          // A tab panel becoming active goes from display:none (0 width) to its
          // real width. Re-fit only the tables inside the newly-shown panel.
          if (mutation.type === 'attributes') {
            const panel =
              mutation.target instanceof HTMLElement ? mutation.target : null;
            if (panel && panel.matches('[data-tab-panel]') && panel.hasAttribute('data-active')) {
              panel.querySelectorAll('table.moss-table').forEach((candidate) => {
                if (candidate instanceof HTMLTableElement) {
                  scheduleTableLayout(candidate);
                }
              });
            }
            continue;
          }

          const targetElement =
            mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
          const targetTagName = targetElement?.tagName;

          if (targetTagName === 'COL' || targetTagName === 'COLGROUP') {
            continue;
          }

          const targetTable = closestTableFromNode(mutation.target);
          if (targetTable) {
            scheduleTableLayout(targetTable);
            continue;
          }

          if (mutation.type === 'childList') {
            const addedTables = collectTablesFromAddedNodes(mutation.addedNodes);
            if (addedTables.length > 0) {
              addedTables.forEach((table) => scheduleTableLayout(table));
              continue;
            }

            const removedTable = collectTablesFromAddedNodes(mutation.removedNodes).length > 0;
            if (mutation.removedNodes.length > 0 && !removedTable) {
              // A structural removal outside any table can change the canvas
              // width available to every table. Removing a table itself only
              // needs observer cleanup; it must not relayout its siblings.
              shouldScheduleAll = true;
            }
          }
        }

        if (removedNodes) {
          unobserveDetachedResizeTargets();
        }

        if (shouldScheduleAll) {
          scheduleAllTableLayouts();
        }
      });

      mutationObserver.observe(rootElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['data-active']
      });

      resizeObserver = new ResizeObserver((entries) => {
        if (entries.some((entry) => entry.target === rootElement)) {
          scheduleAllTableLayouts();
          return;
        }

        entries.forEach((entry) => {
          scheduleTableLayout(closestTableFromNode(entry.target));
        });
      });
      resizeObserverRef.current = resizeObserver;
      resizeObserver.observe(rootElement);

      scheduleAllTableLayouts();
    };

    const unregisterRootListener = editor.registerRootListener((nextRootElement) => {
      connectRootObservers(nextRootElement);
    });

    const unregisterTableMutations = editor.registerMutationListener(
      TableNode,
      (mutations) => {
        for (const [nodeKey, mutation] of mutations) {
          if (mutation === 'destroyed') {
            unobserveDetachedResizeTargets();
            continue;
          }

          const tableElement = closestTableFromNode(editor.getElementByKey(nodeKey));
          if (tableElement) {
            scheduleTableLayout(tableElement);
          }
        }
      }
    );

    connectRootObservers(editor.getRootElement());

    return () => {
      unregisterRootListener();
      unregisterTableMutations();
      disconnectRootObservers();
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      scheduledTablesRef.current.clear();
      scheduledAllTablesRef.current = false;
    };
  }, [editor, scheduleAllTableLayouts, scheduleTableLayout, unobserveDetachedResizeTargets]);

  return null;
}

export default TableColumnLayoutPlugin;
