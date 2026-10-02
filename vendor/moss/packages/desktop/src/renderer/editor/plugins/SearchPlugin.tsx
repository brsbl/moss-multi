// ported-from: packages/desktop/src/renderer/editor/plugins/SearchPlugin.tsx @ 762abb777
import { useCallback, useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getNearestNodeFromDOMNode, SKIP_DOM_SELECTION_TAG } from 'lexical';
import { useAtomValue, useSetAtom } from 'jotai';

import {
  searchStateAtom,
  updateSearchMatchesAtom
} from '@moss/shared';

import { $isTabGroupNode } from '../nodes/TabGroupNode';
import { EDITOR_UPDATE_TAGS } from '../utils/editorUpdateTags';

// Each reveal only opens one nesting level, so allow a few passes for tabs in tabs.
const REVEAL_MAX_FRAMES = 5;

/**
 * Lexical plugin that highlights search matches in the editor using the CSS
 * Custom Highlights API. Walks DOM text nodes under the editor root via
 * TreeWalker and builds Range objects for each match.
 *
 * Zero Lexical state impact: no undo pollution, no serialization concerns.
 */
export function SearchPlugin() {
  const [editor] = useLexicalComposerContext();
  const searchState = useAtomValue(searchStateAtom);
  const updateMatches = useSetAtom(updateSearchMatchesAtom);

  // Store Range objects in a ref (non-serializable, ephemeral)
  const rangesRef = useRef<Range[]>([]);
  // Track the last query + rootElement we processed to avoid redundant work
  const lastQueryRef = useRef('');

  const { query, isActive, currentMatchIndex, navigateVersion } = searchState;

  // Pending reveal frame, cancelled on unmount so a note switch can't re-enter.
  const revealFrameRef = useRef<number | null>(null);
  const revealGenerationRef = useRef(0);

  // Locates the closest tab panel hiding this range, if any.
  const findHiddenPanelTarget = useCallback(
    (range: Range): { group: HTMLElement; panelIndex: number } | null => {
      const hiddenPanel = range.startContainer.parentElement?.closest<HTMLElement>(
        '[data-tab-panel]:not([data-active])'
      );
      if (!hiddenPanel) return null;

      const group = hiddenPanel.parentElement;
      if (!group?.classList.contains('moss-tab-group')) return null;

      const panelIndex = Array.from(group.children)
        .filter((child) => child.hasAttribute('data-tab-panel'))
        .indexOf(hiddenPanel);

      return panelIndex < 0 ? null : { group, panelIndex };
    },
    []
  );

  // Apply "search-current" highlight to the range at currentMatchIndex and scroll it into view.
  // Called imperatively after rebuilding ranges AND reactively on navigation changes.
  const applyCurrentMatch = useCallback((ranges: Range[], matchIndex: number) => {
    const revealGeneration = revealGenerationRef.current + 1;
    revealGenerationRef.current = revealGeneration;
    if (revealFrameRef.current !== null) {
      cancelAnimationFrame(revealFrameRef.current);
      revealFrameRef.current = null;
    }

    if (typeof CSS === 'undefined' || !CSS.highlights) return;

    if (ranges.length === 0 || matchIndex < 0) {
      CSS.highlights.delete('search-current');
      return;
    }

    const currentRange = ranges[matchIndex];
    if (!currentRange) return;

    CSS.highlights.set('search-current', new Highlight(currentRange));

    const revealThenScroll = (remainingFrames: number) => {
      // A match inside an inactive tab panel is display:none, so it paints nothing
      // and measures 0x0 — scrolling to it would land on a bogus offset. Activate
      // its tab first, then re-measure once the panel is laid out.
      const hiddenTarget = remainingFrames > 0 ? findHiddenPanelTarget(currentRange) : null;
      if (hiddenTarget) {
        revealFrameRef.current = requestAnimationFrame(() => {
          if (revealGeneration !== revealGenerationRef.current) return;
          revealFrameRef.current = null;
          editor.update(
            () => {
              const groupNode = $getNearestNodeFromDOMNode(hiddenTarget.group);
              if ($isTabGroupNode(groupNode) && groupNode.getActiveIndex() !== hiddenTarget.panelIndex) {
                groupNode.setActiveIndex(hiddenTarget.panelIndex);
              }
            },
            {
              tag: [
                EDITOR_UPDATE_TAGS.ignored.skipDirty,
                SKIP_DOM_SELECTION_TAG
              ]
            }
          );
          if (revealGeneration !== revealGenerationRef.current) return;
          revealFrameRef.current = requestAnimationFrame(() => {
            if (revealGeneration !== revealGenerationRef.current) return;
            revealFrameRef.current = null;
            revealThenScroll(remainingFrames - 1);
          });
        });
        return;
      }

      // Scroll the current match into view
      const rect = currentRange.getBoundingClientRect();
      // Still unpainted (e.g. a collapsed heading) — leave the view alone rather
      // than scroll to an offset derived from a zero rect.
      if (rect.width === 0 && rect.height === 0) return;

      const scrollContainer = currentRange.startContainer.parentElement?.closest('[data-overlayscrollbars-viewport], .overflow-y-auto');
      if (scrollContainer) {
        const containerRect = scrollContainer.getBoundingClientRect();
        const isVisible =
          rect.top >= containerRect.top &&
          rect.bottom <= containerRect.bottom;

        if (!isVisible) {
          const targetScrollTop =
            scrollContainer.scrollTop + rect.top - containerRect.top - containerRect.height / 3;
          scrollContainer.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
        }
      } else {
        // Fallback: use native scrollIntoView on the range's container
        const container = currentRange.startContainer.parentElement;
        container?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    };

    revealThenScroll(REVEAL_MAX_FRAMES);
  }, [editor, findHiddenPanelTarget]);

  // Main effect: find matches and create highlights
  useEffect(() => {
    if (!isActive || !query) {
      // Clear highlights when search is deactivated
      if (typeof CSS !== 'undefined' && CSS.highlights) {
        CSS.highlights.delete('search-matches');
        CSS.highlights.delete('search-current');
      }
      rangesRef.current = [];
      lastQueryRef.current = '';
      if (isActive && !query) {
        updateMatches({ matchCount: 0 });
      }
      return;
    }

    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    const lowerQuery = query.toLowerCase();
    const ranges: Range[] = [];

    // Walk all text nodes in the editor DOM
    const walker = document.createTreeWalker(rootElement, NodeFilter.SHOW_TEXT);

    let node: Node | null;
    while ((node = walker.nextNode())) {
      const textNode = node as Text;
      const text = textNode.textContent ?? '';
      const lowerText = text.toLowerCase();
      let searchFrom = 0;

      while (searchFrom < lowerText.length) {
        const matchPos = lowerText.indexOf(lowerQuery, searchFrom);
        if (matchPos === -1) break;

        // Create Range for this match
        const range = document.createRange();
        range.setStart(textNode, matchPos);
        range.setEnd(textNode, matchPos + query.length);
        ranges.push(range);

        searchFrom = matchPos + query.length;
      }
    }

    rangesRef.current = ranges;
    lastQueryRef.current = query;

    // Apply CSS Custom Highlights
    if (typeof CSS !== 'undefined' && CSS.highlights) {
      if (ranges.length > 0) {
        CSS.highlights.set('search-matches', new Highlight(...ranges));
      } else {
        CSS.highlights.delete('search-matches');
      }
    }

    updateMatches({ matchCount: ranges.length });

    // Scroll to first match on mount (note switch) / query change
    applyCurrentMatch(ranges, ranges.length > 0 ? 0 : -1);

    return () => {
      // Cleanup on query change
    };
  }, [editor, isActive, query, updateMatches, applyCurrentMatch]);

  // Listen for editor updates to re-run search when content changes
  useEffect(() => {
    if (!isActive || !query) return;

    return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
      // Only re-search if actual content changed (not just selection)
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;

      const rootElement = editor.getRootElement();
      if (!rootElement) return;

      const lowerQuery = query.toLowerCase();
      const ranges: Range[] = [];
      const walker = document.createTreeWalker(rootElement, NodeFilter.SHOW_TEXT);

      let node: Node | null;
      while ((node = walker.nextNode())) {
        const textNode = node as Text;
        const text = textNode.textContent ?? '';
        const lowerText = text.toLowerCase();
        let searchFrom = 0;

        while (searchFrom < lowerText.length) {
          const matchPos = lowerText.indexOf(lowerQuery, searchFrom);
          if (matchPos === -1) break;

          const range = document.createRange();
          range.setStart(textNode, matchPos);
          range.setEnd(textNode, matchPos + query.length);
          ranges.push(range);

          searchFrom = matchPos + query.length;
        }
      }

      rangesRef.current = ranges;

      if (typeof CSS !== 'undefined' && CSS.highlights) {
        if (ranges.length > 0) {
          CSS.highlights.set('search-matches', new Highlight(...ranges));
        } else {
          CSS.highlights.delete('search-matches');
        }
      }

      updateMatches({ matchCount: ranges.length });

      // Re-apply current-match highlight to the (possibly shifted) range
      applyCurrentMatch(ranges, currentMatchIndex);
    });
  }, [editor, isActive, query, currentMatchIndex, updateMatches, applyCurrentMatch]);

  // Navigation-only: update "search-current" highlight when the user cycles matches
  useEffect(() => {
    applyCurrentMatch(rangesRef.current, currentMatchIndex);
  }, [isActive, currentMatchIndex, navigateVersion, applyCurrentMatch]);

  // Cleanup highlights on unmount
  useEffect(() => {
    return () => {
      revealGenerationRef.current += 1;
      if (revealFrameRef.current !== null) {
        cancelAnimationFrame(revealFrameRef.current);
        revealFrameRef.current = null;
      }
      if (typeof CSS !== 'undefined' && CSS.highlights) {
        CSS.highlights.delete('search-matches');
        CSS.highlights.delete('search-current');
      }
    };
  }, []);

  return null;
}
