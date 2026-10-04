// ported-from: packages/desktop/src/renderer/editor/components/FrontmatterHeader.tsx @ 762abb777
import { useAtomValue } from 'jotai';
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { Plus, X } from 'lucide-react';
import { setEditingProperty } from '@moss-multi/host/collab/frontmatter-binding'; // moss-multi seam: open-property (A§10.4)
import { noteFrontmatterAtom, searchStateAtom, workspaceFrontmatterSuggestionsAtom } from '@moss/shared';
import { cn } from '@moss/shared/lib/utils';
import { Input } from '@moss/shared/components/ui/input';
import { Badge } from '@moss/shared/components/ui/badge';
import { Textarea } from '@moss/shared/components/ui/textarea';
import { Label } from '@moss/shared/components/ui/label';
import { Button } from '@moss/shared/components/ui/button';
import { ConfirmationDialog } from '@moss/shared/components/ui/confirmation-dialog';
import type { FrontmatterTypeaheadSuggestions } from '../../../common/noteTypes';

// ============================================================================
// Constants
// ============================================================================

/**
 * Known field ordering. Fields present in frontmatter are displayed in this
 * order first; remaining fields are treated as "custom" and sorted alphabetically.
 */
const KNOWN_FIELD_ORDER = [
  'type',
  'people',
  'description',
  'tags',
  'status',
  'created_date',
] as const;

const KNOWN_KEYS = new Set<string>(KNOWN_FIELD_ORDER);

/** Module-level session pill suggestions accumulator (dynamic field keys). */
const SESSION_PILL_SUGGESTIONS = new Map<string, Set<string>>();

// ============================================================================
// Helpers
// ============================================================================

function formatLabel(key: string): string {
  const spaced = key.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function isDateValue(value: unknown): boolean {
  if (value instanceof Date) return true;
  if (typeof value !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?/.test(value);
}

function formatDate(value: string | Date): string {
  try {
    const date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return String(value);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return String(value);
  }
}

function getDisplayValue(_key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) return formatDate(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return JSON.stringify(value);
  const str = String(value);
  if (isDateValue(str)) return formatDate(str);
  return str;
}

function normalizeSuggestionValue(
  value: unknown,
  options?: { lowercase?: boolean }
): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return options?.lowercase ? trimmed.toLowerCase() : trimmed;
}

function normalizeScalarValue(fieldKey: string, value: string): string {
  const trimmed = value.trim();
  if (fieldKey === 'type' || fieldKey === 'status') {
    return trimmed.toLowerCase();
  }
  return trimmed;
}

function normalizePillValues(fieldKey: string, value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const cleaned = item.trim();
    if (cleaned.length === 0) {
      continue;
    }

    const finalValue = fieldKey === 'tags' ? cleaned.toLowerCase() : cleaned;
    const dedupeKey = fieldKey === 'tags' ? finalValue : finalValue.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    normalized.push(finalValue);
  }

  return normalized;
}

function addSessionPillSuggestions(fieldKey: string, values: string[]): void {
  let bucket = SESSION_PILL_SUGGESTIONS.get(fieldKey);
  if (!bucket) {
    bucket = new Set<string>();
    SESSION_PILL_SUGGESTIONS.set(fieldKey, bucket);
  }
  for (const value of values) {
    const cleaned = value.trim();
    if (cleaned.length > 0) {
      if (bucket.size >= 50) break;
      bucket.add(fieldKey === 'tags' ? cleaned.toLowerCase() : cleaned);
    }
  }
}

function appendPillValue(fieldKey: string, list: string[], rawValue: string): string[] {
  const candidate = rawValue.trim();
  if (candidate.length === 0) {
    return list;
  }

  const nextValue = fieldKey === 'tags' ? candidate.toLowerCase() : candidate;
  const dedupeKey = fieldKey === 'tags' ? nextValue : nextValue.toLowerCase();
  const existingKeys = new Set(
    list.map((entry) => (fieldKey === 'tags' ? entry.toLowerCase() : entry.toLowerCase()))
  );

  if (existingKeys.has(dedupeKey)) {
    return list;
  }

  return [...list, nextValue];
}

function normalizeCustomFieldKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '_');
}

// ============================================================================
// PillFieldEditor
// ============================================================================

interface PillFieldEditorProps {
  fieldKey: string;
  value: unknown;
  suggestionPool: string[];
  onCommit: (value: string[]) => void;
  onCancel: () => void;
}

function PillFieldEditor({
  fieldKey,
  value,
  suggestionPool,
  onCommit,
  onCancel,
}: PillFieldEditorProps) {
  const [pills, setPills] = useState<string[]>(() => normalizePillValues(fieldKey, value));
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedPillIndex, setSelectedPillIndex] = useState<number | null>(null);
  const committedRef = useRef(false);
  const navigatingToPillRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pillRefs = useRef<Map<number, HTMLSpanElement>>(new Map());

  const suggestions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
      return [];
    }

    const existing = new Set(
      pills.map((entry) => (fieldKey === 'tags' ? entry.toLowerCase() : entry.toLowerCase()))
    );

    return suggestionPool
      .filter((entry) => {
        const entryKey = fieldKey === 'tags' ? entry.toLowerCase() : entry.toLowerCase();
        if (existing.has(entryKey)) {
          return false;
        }
        return entry.toLowerCase().includes(normalizedQuery);
      })
      .slice(0, 8);
  }, [fieldKey, pills, query, suggestionPool]);

  useEffect(() => {
    setSelectedIndex((current) => {
      if (suggestions.length === 0) {
        return 0;
      }
      return Math.min(current, suggestions.length - 1);
    });
  }, [suggestions]);

  const acceptCandidate = useCallback(
    (rawValue: string) => {
      setPills((current) => {
        return appendPillValue(fieldKey, current, rawValue);
      });
      setQuery('');
      setSelectedIndex(0);
    },
    [fieldKey]
  );

  const commitWith = useCallback(
    (nextPills: string[]) => {
      if (committedRef.current) {
        return;
      }
      committedRef.current = true;
      const normalized = normalizePillValues(fieldKey, nextPills);
      addSessionPillSuggestions(fieldKey, normalized);
      onCommit(normalized);
    },
    [fieldKey, onCommit]
  );

  const commitCurrent = useCallback(() => {
    // Don't commit when focus is moving to a pill via arrow key navigation
    if (navigatingToPillRef.current) {
      navigatingToPillRef.current = false;
      return;
    }
    const candidate = query.trim();
    if (candidate.length > 0) {
      const selectedSuggestion = suggestions[selectedIndex];
      const next = appendPillValue(fieldKey, pills, selectedSuggestion ?? candidate);
      commitWith(next);
      return;
    }
    commitWith(pills);
  }, [commitWith, fieldKey, pills, query, selectedIndex, suggestions]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      // Let modifier+arrow keys propagate for text cursor navigation (Cmd+Arrow, Shift+Arrow)
      if ((event.metaKey || event.shiftKey) && (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        committedRef.current = true;
        onCancel();
        return;
      }

      if (event.key === 'ArrowDown' && suggestions.length > 0) {
        event.preventDefault();
        setSelectedIndex((current) => (current + 1) % suggestions.length);
        return;
      }

      if (event.key === 'ArrowUp' && suggestions.length > 0) {
        event.preventDefault();
        setSelectedIndex((current) => (current - 1 + suggestions.length) % suggestions.length);
        return;
      }

      // ArrowLeft from start of empty input → select last pill
      if (event.key === 'ArrowLeft' && query.length === 0 && pills.length > 0) {
        event.preventDefault();
        navigatingToPillRef.current = true;
        const targetIndex = pills.length - 1;
        setSelectedPillIndex(targetIndex);
        pillRefs.current.get(targetIndex)?.focus();
        return;
      }

      if (event.key === 'Backspace' && query.length === 0) {
        setPills((current) => {
          return current.slice(0, Math.max(0, current.length - 1));
        });
        return;
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        if (query.trim().length > 0) {
          event.preventDefault();
          const suggestion = suggestions[selectedIndex];
          acceptCandidate(suggestion ?? query);
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
        }
        commitWith(pills);
      }
    },
    [acceptCandidate, commitWith, onCancel, pills, query, selectedIndex, suggestions]
  );

  const handlePillKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>) => {
      if (selectedPillIndex === null) return;

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (selectedPillIndex > 0) {
          const prev = selectedPillIndex - 1;
          setSelectedPillIndex(prev);
          pillRefs.current.get(prev)?.focus();
        }
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (selectedPillIndex < pills.length - 1) {
          const next = selectedPillIndex + 1;
          setSelectedPillIndex(next);
          pillRefs.current.get(next)?.focus();
        } else {
          setSelectedPillIndex(null);
          inputRef.current?.focus();
        }
        return;
      }

      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        const removeIndex = selectedPillIndex;
        setPills((current) => current.filter((_, i) => i !== removeIndex));
        const nextIndex = selectedPillIndex >= pills.length - 1 ? null : selectedPillIndex;
        setSelectedPillIndex(nextIndex);
        if (nextIndex === null) {
          inputRef.current?.focus();
        }
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        setSelectedPillIndex(null);
        inputRef.current?.focus();
      }
    },
    [pills, selectedPillIndex]
  );

  return (
    <div className="relative w-full min-w-0 max-w-xl rounded-md border border-border-clear">
      <div className="flex min-h-7 flex-wrap items-center gap-1.5">
        {pills.map((pill, index) => (
          <Badge
            key={pill}
            tabIndex={-1}
            onKeyDown={handlePillKeyDown}
            ref={(el: HTMLSpanElement | null) => {
              if (el) pillRefs.current.set(index, el);
              else pillRefs.current.delete(index);
            }}
            variant={selectedPillIndex === index ? undefined : 'default'}
            className={cn(
              'gap-1 outline-none',
              selectedPillIndex === index && 'bg-accent-brand/20 ring-1 ring-accent-brand/40'
            )}
          >
            {pill}
            <button
              type="button"
              className="text-ink-faint hover:text-ink-default"
              onMouseDown={(event) => {
                event.preventDefault();
                const removeIndex = index;
                setPills((current) => {
                  return current.filter((_, i) => i !== removeIndex);
                });
                setSelectedPillIndex(null);
              }}
              aria-label={`Remove ${pill}`}
            >
              <X aria-hidden className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        <Input
          ref={inputRef}
          autoFocus
          type="text"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedPillIndex(null);
          }}
          onBlur={commitCurrent}
          onKeyDown={handleKeyDown}
          className="h-6 min-w-24 flex-1 px-2 py-1 text-xs"
          aria-label={`Edit ${fieldKey}`}
        />
      </div>
      {suggestions.length > 0 ? (
        <ul className="absolute left-0 top-full z-50 mt-1 max-h-40 w-full overflow-y-auto rounded-md border border-border-subtle bg-surface-canvas p-1 shadow-floating">
          {suggestions.map((suggestion, index) => (
            <li key={suggestion}>
              <button
                type="button"
                className={`block w-full rounded px-2 py-1 text-left text-xs ${index === selectedIndex ? 'bg-surface-note-selected-bright/50 text-ink-default' : 'text-ink-muted hover:bg-surface-note-selected-bright/30'}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  acceptCandidate(suggestion);
                }}
              >
                {suggestion}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ============================================================================
// FrontmatterValue (read-only display — used for pill fields)
// ============================================================================

interface FrontmatterValueProps {
  fieldKey: string;
  value: unknown;
  onTagClick?: (tag: string) => void;
  onFieldSearchClick?: (query: string) => void;
  activeSearchQuery?: string;
}

const FIELD_QUERY_CLICKABLE_FIELDS = new Set<string>([
  'type',
  'status',
  'created_date',
  'people'
]);

const toCanonicalDateString = (value: unknown): string | null => {
  const formatParts = (year: number, month: number, day: number): string => {
    return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
      .toString()
      .padStart(2, '0')}`;
  };

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatParts(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    return formatParts(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashMatch) {
    const month = Number(slashMatch[1]);
    const day = Number(slashMatch[2]);
    const yearRaw = Number(slashMatch[3]);
    const year = slashMatch[3].length === 2 ? 2000 + yearRaw : yearRaw;
    return formatParts(year, month, day);
  }

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    return formatParts(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate());
  }

  return null;
};

const quoteFieldQueryValue = (value: string): string => {
  const sanitized = value.replace(/"/g, '').trim();
  if (!sanitized) {
    return '';
  }
  return /\s/.test(sanitized) ? `"${sanitized}"` : sanitized;
};

const buildFieldSearchQuery = (fieldKey: string, rawValue: unknown): string | null => {
  if (!FIELD_QUERY_CLICKABLE_FIELDS.has(fieldKey)) {
    return null;
  }

  if (fieldKey === 'created_date') {
    const canonicalDate = toCanonicalDateString(rawValue);
    if (!canonicalDate) {
      return null;
    }
    return `created_date:${canonicalDate}`;
  }

  const normalized = typeof rawValue === 'string'
    ? rawValue.trim()
    : String(rawValue ?? '').trim();
  if (!normalized) {
    return null;
  }

  if (fieldKey === 'type' || fieldKey === 'status') {
    return `${fieldKey}:${quoteFieldQueryValue(normalized.toLowerCase())}`;
  }

  if (fieldKey === 'people') {
    const firstPersonToken = normalized
      .split(',')
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0) ?? normalized;
    return `people:${quoteFieldQueryValue(firstPersonToken)}`;
  }

  return null;
};

function FrontmatterValue({ fieldKey, value, onTagClick, onFieldSearchClick, activeSearchQuery }: FrontmatterValueProps) {
  if (value === null || value === undefined || value === '') {
    return <span className="italic text-ink-faint/60">--</span>;
  }

  if (Array.isArray(value)) {
    const normalized = value
      .map((item) =>
        item != null && typeof item === 'object'
          ? JSON.stringify(item)
          : String(item).trim()
      )
      .filter((item) => item.length > 0);

    if (normalized.length === 0) {
      return <span className="italic text-ink-faint/60">--</span>;
    }

    const badgeVariant = fieldKey === 'people' ? 'secondary' : 'default';

    return (
      <ul className="m-0 flex w-full min-w-0 list-none flex-wrap items-center gap-1.5 p-0">
        {normalized.map((item, i) => {
          if (fieldKey === 'tags' && onTagClick) {
            const isActive = activeSearchQuery != null && item.toLowerCase() === activeSearchQuery.toLowerCase();
            return (
              <li key={`${item}-${i}`} className="max-w-full min-w-0">
                <button
                  type="button"
                  className="max-w-full min-w-0 text-left"
                  onClick={(event) => {
                    event.stopPropagation();
                    onTagClick(item);
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                  }}
                >
                  <Badge
                    variant={badgeVariant}
                    title={item}
                    className={cn(
                      'max-w-full text-left leading-4 cursor-pointer transition-colors hover:bg-surface-note-selected-bright',
                      isActive && '!bg-highlight-search-active/30'
                    )}
                  >
                    <span className="min-w-0 truncate">{item}</span>
                  </Badge>
                </button>
              </li>
            );
          }

          if (fieldKey === 'people' && onFieldSearchClick) {
            const query = buildFieldSearchQuery(fieldKey, item);
            if (query) {
              return (
                <li key={`${item}-${i}`} className="max-w-full min-w-0">
                  <button
                    type="button"
                    className="max-w-full min-w-0 text-left"
                    onClick={(event) => {
                      event.stopPropagation();
                      onFieldSearchClick(query);
                    }}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                    }}
                  >
                    <Badge
                      variant={badgeVariant}
                      title={item}
                      className={cn(
                        'max-w-full text-left leading-4 cursor-pointer transition-colors hover:bg-surface-note-selected-bright',
                        activeSearchQuery != null && query === activeSearchQuery && '!bg-highlight-search-active/30'
                      )}
                    >
                      <span className="min-w-0 truncate">{item}</span>
                    </Badge>
                  </button>
                </li>
              );
            }
          }

          return (
            <li key={`${item}-${i}`} className="max-w-full min-w-0">
              <Badge variant={badgeVariant} title={item} className="max-w-full text-left leading-4"><span className="min-w-0 truncate">{item}</span></Badge>
            </li>
          );
        })}
      </ul>
    );
  }

  // Handle Date objects (js-yaml parses bare dates as Date instances)
  if (value instanceof Date) {
    if (onFieldSearchClick && fieldKey === 'created_date') {
      const query = buildFieldSearchQuery(fieldKey, value);
      if (query) {
        return (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onFieldSearchClick(query);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
            }}
            className="-ml-1.5 rounded-md px-1.5 py-0.5 text-xs text-ink-muted transition-colors hover:bg-surface-note-selected-bright"
          >
            {formatDate(value)}
          </button>
        );
      }
    }
    return <span className="text-xs text-ink-muted">{formatDate(value)}</span>;
  }

  if (typeof value === 'boolean') {
    return <span className="text-xs text-ink-muted">{value ? 'true' : 'false'}</span>;
  }

  if (typeof value === 'object') {
    return (
      <span className="break-words text-xs text-ink-muted">
        {JSON.stringify(value)}
      </span>
    );
  }

  const str = String(value);

  if (isDateValue(str)) {
    if (onFieldSearchClick && fieldKey === 'created_date') {
      const query = buildFieldSearchQuery(fieldKey, value);
      if (query) {
        return (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onFieldSearchClick(query);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
            }}
            className="-ml-1.5 rounded-md px-1.5 py-0.5 text-xs text-ink-muted transition-colors hover:bg-surface-note-selected-bright"
          >
            {formatDate(str)}
          </button>
        );
      }
    }
    return <span className="text-xs text-ink-muted">{formatDate(str)}</span>;
  }

  if (fieldKey === 'description') {
    return <span className="block w-full min-h-5 text-xs leading-normal text-ink-muted">{str}</span>;
  }

  if (onFieldSearchClick && FIELD_QUERY_CLICKABLE_FIELDS.has(fieldKey)) {
    const query = buildFieldSearchQuery(fieldKey, value);
    if (query) {
      return (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onFieldSearchClick(query);
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
          }}
          className="-ml-1.5 rounded-md px-1.5 py-0.5 text-xs text-ink-muted transition-colors hover:bg-surface-note-selected-bright"
        >
          {str}
        </button>
      );
    }
  }

  // All scalar fields (standard + custom) use consistent styling
  return <span className="text-xs text-ink-muted">{str}</span>;
}

// ============================================================================
// AddCustomFieldRow (inline key-value input for new fields)
// ============================================================================

interface AddCustomFieldRowProps {
  existingKeys: Set<string>;
  onCommit: (key: string, value: string) => void;
  onCancel: () => void;
}

function AddCustomFieldRow({ existingKeys, onCommit, onCancel }: AddCustomFieldRowProps) {
  const [keyDraft, setKeyDraft] = useState('');
  const [valueDraft, setValueDraft] = useState('');
  const [phase, setPhase] = useState<'key' | 'value'>('key');
  const keyInputRef = useRef<HTMLInputElement>(null);
  const valueInputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  const normalizedKey = normalizeCustomFieldKey(keyDraft);
  const isDuplicate = normalizedKey.length > 0 && existingKeys.has(normalizedKey);

  const commitField = useCallback(() => {
    if (committedRef.current) return;
    const key = normalizedKey;
    if (key.length === 0 || isDuplicate) {
      committedRef.current = true;
      onCancel();
      return;
    }
    committedRef.current = true;
    onCommit(key, valueDraft.trim());
  }, [isDuplicate, normalizedKey, onCancel, onCommit, valueDraft]);

  const handleKeyKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        committedRef.current = true;
        onCancel();
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        if (normalizedKey.length === 0 || isDuplicate) return;
        setPhase('value');
        requestAnimationFrame(() => valueInputRef.current?.focus());
      }
    },
    [isDuplicate, normalizedKey, onCancel]
  );

  const handleValueKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        committedRef.current = true;
        onCancel();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        commitField();
      }
    },
    [commitField, onCancel]
  );

  const handleKeyBlur = useCallback(() => {
    if (phase === 'key' && normalizedKey.length === 0) {
      if (!committedRef.current) {
        committedRef.current = true;
        onCancel();
      }
    }
  }, [normalizedKey, onCancel, phase]);

  if (phase === 'value') {
    return (
      <Fragment>
        <Label className="m-0 flex min-h-7 items-center font-mono text-micro font-normal leading-4 text-ink-faint">
          {formatLabel(normalizedKey)}
        </Label>
        <div className="m-0 flex min-h-7 min-w-0 items-center">
          <Input
            ref={valueInputRef}
            autoFocus
            type="text"
            value={valueDraft}
            onChange={(event) => setValueDraft(event.target.value)}
            onKeyDown={handleValueKeyDown}
            onBlur={() => commitField()}
            placeholder="value"
            className="h-7 px-2 py-1 text-xs"
            aria-label="New field value"
          />
        </div>
      </Fragment>
    );
  }

  return (
    <div className="col-span-2 flex min-h-7 items-center">
      <Input
        ref={keyInputRef}
        autoFocus
        type="text"
        value={keyDraft}
        onChange={(event) => setKeyDraft(event.target.value)}
        onKeyDown={handleKeyKeyDown}
        onBlur={handleKeyBlur}
        placeholder={isDuplicate ? 'Already exists' : 'field name'}
        className={cn(
          'h-7 w-20 px-2 py-1 text-xs',
          isDuplicate ? 'border-accent-terracotta/40 text-accent-terracotta placeholder:text-accent-terracotta/60' : ''
        )}
        aria-label="New field name"
      />
    </div>
  );
}

// ============================================================================
// FrontmatterPropertyGrid
// ============================================================================

interface FrontmatterPropertyGridProps {
  entries: Array<[string, unknown]>;
  suggestionPools: FrontmatterTypeaheadSuggestions;
  onFieldChange?: (field: string, value: unknown) => void;
  onFieldDelete?: (field: string) => void;
  onTagClick?: (tag: string) => void;
  onFieldSearchClick?: (query: string) => void;
  showAddField?: boolean;
  onAddFieldStart?: () => void;
  onAddFieldEnd?: () => void;
  addingField?: boolean;
  onEditingFieldChange?: (field: string | null) => void; // moss-multi seam: open-property (A§10.4)
}

export function FrontmatterPropertyGrid({
  entries,
  suggestionPools,
  onFieldChange,
  onFieldDelete,
  onTagClick,
  onFieldSearchClick,
  showAddField,
  onAddFieldStart,
  onAddFieldEnd,
  addingField,
  onEditingFieldChange,
}: FrontmatterPropertyGridProps) {
  const isEditable = Boolean(onFieldChange);
  const searchState = useAtomValue(searchStateAtom);
  const activeSearchQuery = searchState.isActive ? searchState.query : undefined;

  const [editingField, setEditingField] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const [deletingField, setDeletingField] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const existingKeys = useMemo(() => {
    return new Set(entries.map(([key]) => key));
  }, [entries]);

  const suggestionPoolByField = useMemo((): Record<string, string[]> => {
    const pools: Record<string, Set<string>> = {};

    const getOrCreatePool = (fieldKey: string): Set<string> => {
      if (!pools[fieldKey]) {
        pools[fieldKey] = new Set<string>();
      }
      return pools[fieldKey];
    };

    // Seed from workspace suggestions (IPC)
    for (const [fieldKey, values] of Object.entries(suggestionPools)) {
      const pool = getOrCreatePool(fieldKey);
      for (const entry of values) {
        const cleaned = normalizeSuggestionValue(entry, { lowercase: fieldKey === 'tags' });
        if (cleaned) pool.add(cleaned);
      }
    }

    // Merge session pill suggestions
    for (const [fieldKey, sessionValues] of SESSION_PILL_SUGGESTIONS) {
      const pool = getOrCreatePool(fieldKey);
      for (const entry of sessionValues) {
        pool.add(entry);
      }
    }

    // Merge current entry values so they appear as suggestions too
    for (const [key, value] of entries) {
      const pool = getOrCreatePool(key);
      if (Array.isArray(value)) {
        for (const item of normalizePillValues(key, value)) {
          const cleaned = normalizeSuggestionValue(item, { lowercase: key === 'tags' });
          if (cleaned) pool.add(cleaned);
        }
      } else {
        const cleaned = normalizeSuggestionValue(value, { lowercase: key === 'type' || key === 'status' });
        if (cleaned) pool.add(cleaned);
      }
    }

    // Convert sets to sorted arrays
    const result: Record<string, string[]> = {};
    for (const [fieldKey, pool] of Object.entries(pools)) {
      result[fieldKey] = [...pool].sort((a, b) => a.localeCompare(b));
    }
    return result;
  }, [entries, suggestionPools]);

  // moss-multi seam: open-property (A§10.4): the binding keeps this field's row while its draft is open
  useEffect(() => {
    onEditingFieldChange?.(editingField);
  }, [editingField, onEditingFieldChange]);
  useEffect(() => () => onEditingFieldChange?.(null), [onEditingFieldChange]);

  useEffect(() => {
    if (!editingField) {
      return;
    }
    if (!entries.some(([key]) => key === editingField)) {
      setEditingField(null);
    }
  }, [editingField, entries]);

  const startEditing = useCallback(
    (fieldKey: string) => {
      if (!isEditable || fieldKey === 'created_date') {
        return;
      }
      const entry = entries.find(([k]) => k === fieldKey);
      const currentValue = entry ? entry[1] : '';
      setEditingField(fieldKey);
      setDraft(typeof currentValue === 'string' ? currentValue : getDisplayValue(fieldKey, currentValue));
      setSelectedSuggestionIndex(0);
    },
    [isEditable, entries]
  );

  const commitEditing = useCallback(
    (fieldKey: string, overrideValue?: string) => {
      const finalValue = overrideValue ?? draft;
      if (fieldKey === 'description') {
        onFieldChange?.(fieldKey, finalValue.trim());
      } else {
        onFieldChange?.(fieldKey, normalizeScalarValue(fieldKey, finalValue));
      }
      setEditingField(null);
    },
    [draft, onFieldChange]
  );

  const cancelEditing = useCallback(() => {
    setEditingField(null);
  }, []);

  const finishPillEditing = useCallback(
    (fieldKey: string, value: unknown) => {
      onFieldChange?.(fieldKey, value);
      setEditingField(null);
    },
    [onFieldChange]
  );

  // Focus management for editing fields
  useLayoutEffect(() => {
    if (!editingField) return;
    // Pill fields (array values) manage their own focus via autoFocus
    const editingEntry = entries.find(([k]) => k === editingField);
    if (editingEntry && Array.isArray(editingEntry[1])) return;

    if (editingField === 'description') {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    } else {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    }
  }, [editingField]);

  // Auto-resize textarea for description
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, editingField]);

  const getSuggestions = useCallback(
    (fieldKey: string): string[] => {
      const pool = suggestionPoolByField[fieldKey];
      if (!pool || pool.length === 0) return [];
      const query = draft.trim().toLowerCase();
      if (query.length === 0) return [];
      return pool.filter((option) => option.toLowerCase().includes(query)).slice(0, 8);
    },
    [draft, suggestionPoolByField]
  );

  const handleScalarKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>, fieldKey: string) => {
      const suggestions = getSuggestions(fieldKey);

      if (event.key === 'Escape') {
        event.preventDefault();
        cancelEditing();
        return;
      }

      if (event.key === 'ArrowDown' && suggestions.length > 0) {
        event.preventDefault();
        setSelectedSuggestionIndex((current) => (current + 1) % suggestions.length);
        return;
      }

      if (event.key === 'ArrowUp' && suggestions.length > 0) {
        event.preventDefault();
        setSelectedSuggestionIndex((current) => (current - 1 + suggestions.length) % suggestions.length);
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        if (suggestions.length > 0) {
          commitEditing(fieldKey, suggestions[selectedSuggestionIndex]);
          return;
        }
        commitEditing(fieldKey);
        return;
      }

      if (event.key === 'Tab' && suggestions.length > 0) {
        event.preventDefault();
        commitEditing(fieldKey, suggestions[selectedSuggestionIndex]);
      }
    },
    [cancelEditing, commitEditing, getSuggestions, selectedSuggestionIndex]
  );

  const handleDescKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>, fieldKey: string) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelEditing();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        commitEditing(fieldKey);
      }
    },
    [cancelEditing, commitEditing]
  );

  // Clamp suggestion index when suggestions change
  useEffect(() => {
    if (!editingField) return;
    const suggestions = getSuggestions(editingField);
    setSelectedSuggestionIndex((current) => {
      if (suggestions.length === 0) return 0;
      return Math.min(current, suggestions.length - 1);
    });
  }, [draft, editingField, getSuggestions]);

  const handleAddFieldCommit = useCallback(
    (key: string, value: string) => {
      onFieldChange?.(key, value);
      onAddFieldEnd?.();
    },
    [onFieldChange, onAddFieldEnd]
  );

  const handleAddFieldCancel = useCallback(() => {
    onAddFieldEnd?.();
  }, [onAddFieldEnd]);

  return (
    <form
      onSubmit={(e) => e.preventDefault()}
      className="m-0 grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-xs gap-y-1.5 rounded-lg border border-border-raised bg-surface-raised-card p-3 shadow-sm"
    >
      {entries.map(([key, value]) => {
        const isEditableField = isEditable && key !== 'created_date';
        const isPillField = Array.isArray(value);
        const isDescription = key === 'description';
        const isEditing = editingField === key;
        const suggestions = isEditing ? getSuggestions(key) : [];

        return (
          <Fragment key={key}>
            <Label className="group/label m-0 flex min-h-7 min-w-0 items-center font-mono text-micro font-normal leading-4 text-ink-faint">
              <span className="flex min-w-0 items-center gap-1 break-words">
                {formatLabel(key)}
                {isEditableField && onFieldDelete ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={(event) => {
                      event.stopPropagation();
                      setDeletingField(key);
                    }}
                    className="invisible h-4 w-4 shrink-0 text-ink-faint/60 hover:text-ink-muted group-hover/label:visible"
                    aria-label={`Delete ${key} field`}
                  >
                    <X aria-hidden className="h-2.5 w-2.5" />
                  </Button>
                ) : null}
              </span>
            </Label>

            {isPillField ? (
              <div
                onClick={(event) => {
                  if (!isEditable || isEditing) return;
                  const target = event.target as HTMLElement;
                  if (target.closest('button') || target.closest('a')) return;
                  startEditing(key);
                }}
                className={cn(
                  'relative m-0 flex min-h-7 min-w-0 items-start text-left',
                )}
              >
                {isEditing ? (
                  <PillFieldEditor
                    fieldKey={key}
                    value={value}
                    suggestionPool={suggestionPoolByField[key] ?? []}
                    onCommit={(nextValue) => finishPillEditing(key, nextValue)}
                    onCancel={cancelEditing}
                  />
                ) : (
                  <div
                    className={cn(
                      'flex min-h-7 w-full min-w-0 items-start justify-start rounded-md py-1 text-left',
                      isEditableField ? 'cursor-text' : 'cursor-default',
                    )}
                  >
                    <FrontmatterValue
                      fieldKey={key}
                      value={value}
                      onTagClick={key === 'tags' ? onTagClick : undefined}
                      onFieldSearchClick={onFieldSearchClick}
                      activeSearchQuery={activeSearchQuery}
                    />
                  </div>
                )}
              </div>
            ) : isDescription ? (
              <Textarea
                ref={isEditing ? textareaRef : undefined}
                readOnly={!isEditing}
                tabIndex={isEditing ? 0 : -1}
                value={isEditing ? draft : String(value ?? '')}
                onClick={() => {
                  if (isEditableField && !isEditing) startEditing(key);
                }}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                  if (isEditing) commitEditing(key);
                }}
                onKeyDown={(e) => handleDescKeyDown(e, key)}
                className={cn(
                  '!min-h-7 resize-none overflow-hidden py-px text-left text-xs leading-4',
                  isEditing
                    ? 'border-border-default bg-surface-raised-control-hover text-ink-default'
                    : isEditableField
                      ? 'bg-surface-raised-control text-ink-muted cursor-text hover:bg-surface-raised-control-hover'
                      : '!bg-surface-transparent text-ink-muted cursor-default pointer-events-none'
                )}
                aria-label={`${isEditing ? 'Edit' : ''} description`}
              />
            ) : (
              <div className="relative min-w-0">
                <Input
                  ref={isEditing ? inputRef : undefined}
                  readOnly={!isEditing}
                  tabIndex={isEditing ? 0 : -1}
                  value={isEditing ? draft : getDisplayValue(key, value)}
                  onClick={() => {
                    if (!isEditableField) {
                      if (onFieldSearchClick && key === 'created_date') {
                        const query = buildFieldSearchQuery(key, value);
                        if (query) onFieldSearchClick(query);
                      }
                      return;
                    }
                    if (!isEditing) startEditing(key);
                  }}
                  onFocus={() => {
                    if (!isEditing && isEditableField) startEditing(key);
                  }}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => {
                    if (isEditing) commitEditing(key);
                  }}
                  onKeyDown={(e) => handleScalarKeyDown(e, key)}
                  className={cn(
                    'h-7 px-2 py-1 text-left text-xs',
                    isEditing
                      ? 'border-border-default bg-surface-raised-control-hover text-ink-default'
                      : isEditableField
                        ? 'bg-surface-raised-control text-ink-muted cursor-text hover:bg-surface-raised-control-hover'
                        : '!bg-surface-transparent text-ink-muted cursor-default pointer-events-none'
                  )}
                  aria-label={`${isEditing ? 'Edit ' : ''}${key}`}
                />
                {isEditing && suggestions.length > 0 ? (
                  <ul className="absolute left-0 top-full z-50 mt-1 max-h-40 w-full overflow-y-auto rounded-md border border-border-subtle bg-surface-canvas p-1 shadow-floating">
                    {suggestions.map((suggestion, index) => (
                      <li key={suggestion}>
                        <button
                          type="button"
                          className={`block w-full rounded px-2 py-1 text-left text-xs ${index === selectedSuggestionIndex ? 'bg-surface-note-selected-bright/50 text-ink-default' : 'text-ink-muted hover:bg-surface-note-selected-bright/30'}`}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            commitEditing(key, suggestion);
                          }}
                        >
                          {suggestion}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
          </Fragment>
        );
      })}

      {/* Inline add-field row */}
      {addingField ? (
        <AddCustomFieldRow
          existingKeys={existingKeys}
          onCommit={handleAddFieldCommit}
          onCancel={handleAddFieldCancel}
        />
      ) : null}

      {/* Footer row: add field button */}
      {showAddField && isEditable && !addingField ? (
        <div className="col-span-2 flex items-center pt-0.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              onAddFieldStart?.();
            }}
            className="-ml-1.5 h-6 gap-0.5 px-1.5 text-micro font-normal text-ink-faint hover:bg-surface-transparent hover:text-ink-muted"
            aria-label="Add field"
          >
            <Plus aria-hidden className="h-2.5 w-2.5" />
            Add field
          </Button>
        </div>
      ) : null}

      <ConfirmationDialog
        open={deletingField !== null}
        onOpenChange={(open) => { if (!open) setDeletingField(null); }}
        title={`Remove "${deletingField ? formatLabel(deletingField) : ''}"?`}
        description="This will remove the property and its value from this note's frontmatter."
        confirmLabel="Remove"
        variant="danger"
        onConfirm={() => {
          if (deletingField) {
            onFieldDelete?.(deletingField);
            setDeletingField(null);
          }
        }}
      />
    </form>
  );
}

// ============================================================================
// FrontmatterHeader (main export)
// ============================================================================

interface FrontmatterHeaderProps {
  noteId: string;
  // moss-multi seam: structured-properties (A§10.4): the shared map supplies display order.
  preserveOrder?: boolean;
  onFieldChange?: (field: string, value: unknown) => void;
  onTagClick?: (tag: string) => void;
  onFieldSearchClick?: (query: string) => void;
}

export function FrontmatterHeader({
  noteId,
  preserveOrder = false,
  onFieldChange,
  onTagClick,
  onFieldSearchClick,
}: FrontmatterHeaderProps) {
  const frontmatter = useAtomValue(noteFrontmatterAtom(noteId));
  const workspaceSuggestions = useAtomValue(workspaceFrontmatterSuggestionsAtom) as FrontmatterTypeaheadSuggestions;
  const [addingField, setAddingField] = useState(false);
  const customFieldOrderRef = useRef<string[] | null>(null);

  const handleFieldDelete = useCallback(
    (field: string) => {
      onFieldChange?.(field, undefined);
    },
    [onFieldChange]
  );
  // moss-multi seam: open-property (A§10.4)
  const handleEditingFieldChange = useCallback((field: string | null) => setEditingProperty(noteId, field), [noteId]);

  if (frontmatter === null) {
    return null;
  }

  const data = frontmatter;
  const isEditable = Boolean(onFieldChange);

  // Panel mode: description first (most valuable context), then high-signal fields,
  // then metadata, then custom fields alphabetically
  const panelFieldOrder = [
    'created_date',
    'description',
    'tags',
    'status',
    'type',
    'people',
  ] as const;
  const panelOrderSet = new Set<string>(panelFieldOrder);
  const orderedEntries: Array<[string, unknown]> = [];

  for (const key of panelFieldOrder) {
    if (key in data) {
      orderedEntries.push([key, data[key]]);
    }
  }
  for (const key of KNOWN_FIELD_ORDER) {
    if (!panelOrderSet.has(key) && key in data) {
      orderedEntries.push([key, data[key]]);
    }
  }
  const extraKeys = Object.keys(data).filter((k) => !KNOWN_KEYS.has(k));
  if (!customFieldOrderRef.current) {
    extraKeys.sort();
    customFieldOrderRef.current = [...extraKeys];
  } else {
    const known = customFieldOrderRef.current;
    const knownSet = new Set(known);
    const ordered = known.filter((k) => extraKeys.includes(k));
    for (const k of extraKeys) {
      if (!knownSet.has(k)) ordered.push(k);
    }
    customFieldOrderRef.current = ordered;
    extraKeys.length = 0;
    extraKeys.push(...ordered);
  }
  for (const key of extraKeys) {
    orderedEntries.push([key, data[key]]);
  }

  const filteredEntries = (preserveOrder ? Object.entries(data) : orderedEntries).filter(([key, value]) => {
    if (key === 'created_date') return true;
    if (!KNOWN_KEYS.has(key)) return true;
    if (value === null || value === undefined || value === '') return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
  });

  return (
    <section aria-label="Frontmatter properties">
      <FrontmatterPropertyGrid
        entries={filteredEntries}
        suggestionPools={workspaceSuggestions}
        onFieldChange={onFieldChange}
        onFieldDelete={handleFieldDelete}
        onTagClick={onTagClick}
        onFieldSearchClick={onFieldSearchClick}
        showAddField={isEditable}
        onAddFieldStart={() => setAddingField(true)}
        onAddFieldEnd={() => setAddingField(false)}
        addingField={addingField}
        onEditingFieldChange={handleEditingFieldChange}
      />
    </section>
  );
}
