// ported-from: packages/desktop/src/renderer/components/NoteSearchInput.tsx @ 762abb777
import { useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';

import {
  searchStateAtom,
  setSearchQueryAtom,
  clearSearchAtom,
  navigateSearchMatchAtom
} from '@moss/shared';
import { SearchToolbarInput } from './SearchToolbarInput';

interface NoteSearchInputProps {
  onClose: () => void;
  autoFocus?: boolean;
  fullWidth?: boolean;
}

export function NoteSearchInput({ onClose, autoFocus = true, fullWidth = false }: NoteSearchInputProps) {
  const searchState = useAtomValue(searchStateAtom);
  const setQuery = useSetAtom(setSearchQueryAtom);
  const clearSearch = useSetAtom(clearSearchAtom);
  const navigateMatch = useSetAtom(navigateSearchMatchAtom);

  const { query, matchCount, currentMatchIndex } = searchState;

  const handleClose = useCallback(() => {
    clearSearch();
    onClose();
  }, [clearSearch, onClose]);

  return (
    <SearchToolbarInput
      value={query}
      onValueChange={setQuery}
      matchCount={matchCount}
      currentMatchIndex={currentMatchIndex}
      onPreviousMatch={() => navigateMatch('prev')}
      onNextMatch={() => navigateMatch('next')}
      onClose={handleClose}
      placeholder="Find in note..."
      ariaLabel="Find in note"
      inputDataAttributes={{ 'data-moss-note-search-input': true }}
      autoFocus={autoFocus}
      fullWidth={fullWidth}
    />
  );
}
