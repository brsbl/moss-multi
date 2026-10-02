// ported-from: packages/desktop/src/renderer/components/LinksSection.tsx @ 762abb777
import * as React from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { ArrowBigLeft, FileText, Link2 } from 'lucide-react';
import { cn } from '@moss/shared/lib/utils';
import { suggestedLinkCandidatesAtom, type SuggestedLinkCandidate } from '@moss/shared/state/note-atoms';
import {
  linksTabAtom,
  noteLinksAtom,
  type LinksTabType,
  type NoteLinkInfo
} from '@moss/shared/state/atoms';

interface LinksSectionProps {
  activeNoteId: string | null;
  onNavigateToNote: (noteId: string) => void;
  activeFrontmatter?: Record<string, unknown> | null;
  /** Whether to show a top divider (shown only when section has content) */
  showDivider?: boolean;
  /** When false, hides the suggested-links tab. Defaults to true. */
  noteIntelligenceEnabled?: boolean;
}

interface LinkItemProps {
  link: NoteLinkInfo;
  onClick: () => void;
  suggestionReason?: string;
}

interface LinksTabConfig {
  id: LinksTabType;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  items: NoteLinkInfo[];
}

/** @deprecated Use SuggestedLinkCandidate from note-atoms.ts */
export type SuggestedLinksNote = SuggestedLinkCandidate;

export interface SuggestedLinkInfo extends NoteLinkInfo {
  suggestionScore: number;
  suggestionReason: string;
}

// ── Suggested links algorithm ────────────────────────────────────────────────

const TITLE_MIN_TOKEN_LENGTH = 3;
const FRONTMATTER_MIN_TOKEN_LENGTH = 2;
const FOLDER_SCORE = 1;
const TITLE_TOPIC_SCORE = 2;
const BODY_PHRASE_BASE_SCORE = 5;
const BODY_PHRASE_MATCH_SCORE = 2;
const BODY_TOKEN_OVERLAP_BOOST = 1;
const FRONTMATTER_OVERLAP_SCORE_CAP = 4;
const SUGGESTED_LINK_MIN_SCORE = 3;
const SUGGESTED_LINK_LIMIT = 5;
const CONTENT_SIGNAL_MAX_CHARS = 2400;
const CONTENT_SIGNAL_MAX_TOKENS = 48;
const CONTENT_SIGNAL_MAX_PHRASES = 64;
const CONTENT_SIGNAL_MIN_TOKEN_LENGTH = 3;
const BODY_TOKEN_MIN_OVERLAP = 3;
const DATE_LIKE_STRING_RE =
  /^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const TITLE_STOP_WORDS = new Set([
  'a',
  'about',
  'all',
  'also',
  'an',
  'and',
  'any',
  'are',
  'but',
  'by',
  'can',
  'did',
  'do',
  'does',
  'for',
  'from',
  'get',
  'got',
  'had',
  'has',
  'have',
  'her',
  'here',
  'him',
  'his',
  'how',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'let',
  'may',
  'more',
  'most',
  'my',
  'new',
  'no',
  'nor',
  'not',
  'note',
  'notes',
  'now',
  'of',
  'on',
  'one',
  'only',
  'or',
  'our',
  'out',
  'own',
  'per',
  'set',
  'she',
  'so',
  'some',
  'than',
  'that',
  'the',
  'then',
  'they',
  'this',
  'to',
  'too',
  'up',
  'use',
  'very',
  'was',
  'we',
  'what',
  'when',
  'who',
  'why',
  'will',
  'with',
  'you',
  'your'
]);

const tokenizeText = (text: string, minLength = TITLE_MIN_TOKEN_LENGTH): Set<string> => {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= minLength && !TITLE_STOP_WORDS.has(token));
  return new Set(tokens);
};

const NEGATED_CONTEXT_RE =
  /(?:not\s+(?:about|related\s+to|focused\s+on|cluster\s+with)|(?:should\s+)?(?:stay\s+)?unrelated\s+to|should\s+not\s+cluster\s+with)\s+[^.\n]+/gi;
const NEGATIVE_OR_REGRESSION_SENTENCE_RE = /[^.\n]*(?:unchanged|should\s+not|does\s+not\s+appear|must\s+not|unrelated\s+to)[^.\n]*/gi;

const stripNegatedContentSignal = (value: string): string =>
  value
    .replace(NEGATED_CONTEXT_RE, ' ')
    .replace(NEGATIVE_OR_REGRESSION_SENTENCE_RE, ' ');

const normalizeSignalTokens = (text: string | undefined): string[] => {
  if (!text) {
    return [];
  }
  return stripNegatedContentSignal(text)
    .slice(0, CONTENT_SIGNAL_MAX_CHARS)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) =>
      token.length >= CONTENT_SIGNAL_MIN_TOKEN_LENGTH &&
      !TITLE_STOP_WORDS.has(token) &&
      !/^\d+$/.test(token)
    );
};

type TopicSignal = {
  tokens: Set<string>;
  phrases: Set<string>;
  phraseCounts: Map<string, number>;
};

const buildPhraseCounts = (tokens: string[], sizes: number[] = [3, 4]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const size of sizes) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      const phraseTokens = tokens.slice(index, index + size);
      const phrase = phraseTokens.join(' ');
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }
  return counts;
};

const buildTitleTopicSignal = (title: string): TopicSignal => {
  const tokens = normalizeSignalTokens(title).filter((token) => !TITLE_STOP_WORDS.has(token));
  const phraseCounts = buildPhraseCounts(tokens, [2, 3]);
  return {
    tokens: new Set(tokens),
    phrases: new Set(phraseCounts.keys()),
    phraseCounts
  };
};

const buildContentTopicSignal = (_title: string, text: string | undefined): TopicSignal => {
  const rawTokens = normalizeSignalTokens(text);
  const tokenCounts = new Map<string, number>();
  for (const token of rawTokens) {
    tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
  }

  const tokens = new Set<string>();
  for (const token of tokenCounts.keys()) {
    tokens.add(token);
    if (tokens.size >= CONTENT_SIGNAL_MAX_TOKENS) {
      break;
    }
  }

  const phraseCounts = buildPhraseCounts(rawTokens);
  const phrases = new Set<string>();
  for (const phrase of phraseCounts.keys()) {
    phrases.add(phrase);
    if (phrases.size >= CONTENT_SIGNAL_MAX_PHRASES) {
      break;
    }
  }

  return { tokens, phrases, phraseCounts };
};

const collectTokenOverlap = (a: Set<string>, b: Set<string>): string[] => {
  const overlap: string[] = [];
  for (const token of a) {
    if (b.has(token)) {
      overlap.push(token);
    }
  }
  return overlap.sort((left, right) => right.length - left.length || left.localeCompare(right));
};

const collectPhraseOverlap = collectTokenOverlap;

const hasRepeatedPhraseToken = (phrase: string): boolean => {
  const tokens = phrase.split(' ');
  return new Set(tokens).size !== tokens.length;
};

const compactTopicMatches = (matches: string[]): string[] => {
  const phrases = matches.filter((match) => match.includes(' '));
  return matches.filter((match) => {
    if (match.includes(' ')) {
      return true;
    }
    return !phrases.some((phrase) => phrase.split(' ').includes(match));
  });
};

const compactBodyTopicPhrases = (matches: string[]): string[] => {
  const compact: string[] = [];
  for (const match of matches) {
    const tokens = match.split(' ');
    const overlapsExisting = compact.some((existing) => {
      const existingTokens = new Set(existing.split(' '));
      const sharedCount = tokens.filter((token) => existingTokens.has(token)).length;
      return sharedCount >= Math.min(2, tokens.length, existingTokens.size);
    });
    if (!overlapsExisting) {
      compact.push(match);
    }
  }
  return compact;
};

const isExternalSystemFolderPath = (folderPath: string): boolean => {
  return folderPath.split('/').includes('External');
};

const splitFolderPath = (folderPath: string): string[] =>
  folderPath
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

const sharesNonRootFolderBranch = (leftFolderPath: string, rightFolderPath: string): boolean => {
  const leftSegments = splitFolderPath(leftFolderPath);
  const rightSegments = splitFolderPath(rightFolderPath);
  if (leftSegments[0] !== 'Notes' || rightSegments[0] !== 'Notes') {
    return false;
  }

  let sharedPrefixLength = 0;
  const maxPrefix = Math.min(leftSegments.length, rightSegments.length);
  while (sharedPrefixLength < maxPrefix && leftSegments[sharedPrefixLength] === rightSegments[sharedPrefixLength]) {
    sharedPrefixLength += 1;
  }

  // Require at least one shared segment beyond root "Notes".
  return sharedPrefixLength >= 2;
};

const addFrontmatterTokens = (tokens: Set<string>, value: unknown): void => {
  if (typeof value === 'string') {
    const normalized = value.trim().replace(/^#/, '');
    if (!normalized) {
      return;
    }
    if (DATE_LIKE_STRING_RE.test(normalized)) {
      return;
    }
    for (const token of tokenizeText(normalized, FRONTMATTER_MIN_TOKEN_LENGTH)) {
      if (/^\d+$/.test(token)) {
        continue;
      }
      tokens.add(token);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      addFrontmatterTokens(tokens, item);
    }
    return;
  }

  if (value instanceof Date) {
    return;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return;
  }

  if (value && typeof value === 'object') {
    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      addFrontmatterTokens(tokens, nestedValue);
    }
  }
};

/**
 * Only `tags` and `description` contribute semantic signal. Everything else —
 * `status`, dates, year-only numerics, and any other field — is ignored.
 * Date-like and numeric tokens are dropped inside `addFrontmatterTokens`.
 */
const collectActiveMetadataTokens = (
  activeFrontmatter: Record<string, unknown> | null | undefined
): { tagsTokens: Set<string>; descriptionTokens: Set<string>; phraseTokens: Set<string> } => {
  const tagsTokens = new Set<string>();
  const descriptionTokens = new Set<string>();
  const phraseTokens = new Set<string>();
  if (!activeFrontmatter) {
    return { tagsTokens, descriptionTokens, phraseTokens };
  }

  const addPhraseTokens = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const phrase of buildPhraseCounts(normalizeSignalTokens(value)).keys()) {
        phraseTokens.add(phrase);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        addPhraseTokens(item);
      }
    }
  };

  for (const [field, value] of Object.entries(activeFrontmatter)) {
    const key = field.toLowerCase();
    if (key === 'tags') {
      addFrontmatterTokens(tagsTokens, value);
      addPhraseTokens(value);
    } else if (key === 'description') {
      addFrontmatterTokens(descriptionTokens, value);
    }
  }

  return { tagsTokens, descriptionTokens, phraseTokens };
};

export const buildSuggestedLinks = (
  activeNoteId: string | null,
  notes: ReadonlyArray<SuggestedLinkCandidate>,
  currentLinks: { outgoing: NoteLinkInfo[]; incoming: NoteLinkInfo[] },
  options?: {
    minScore?: number;
    limit?: number;
    activeFrontmatter?: Record<string, unknown> | null;
  }
): SuggestedLinkInfo[] => {
  if (!activeNoteId) {
    return [];
  }

  const minScore = options?.minScore ?? SUGGESTED_LINK_MIN_SCORE;
  const limit = options?.limit ?? SUGGESTED_LINK_LIMIT;
  const activeNote = notes.find((note) => note.id === activeNoteId);
  if (!activeNote) {
    return [];
  }

  // Related shows notes the active note already links to (outgoing), so those are
  // NOT filtered out. Incoming backlinks are surfaced in the Backlinks tab, so they
  // stay excluded here to avoid duplicating that panel; the active note is always excluded.
  const existingLinkedIds = new Set<string>([activeNoteId]);
  for (const link of currentLinks.incoming) {
    existingLinkedIds.add(link.noteId);
  }
  const outgoingLinkedIds = new Set(currentLinks.outgoing.map((link) => link.noteId));

  const activeTitleSignal = buildTitleTopicSignal(activeNote.title);
  const activeContentSignal = buildContentTopicSignal(activeNote.title, activeNote.contentSignalText);
  const { tagsTokens, descriptionTokens, phraseTokens } = collectActiveMetadataTokens(options?.activeFrontmatter);
  const frontmatterTokens = new Set([...tagsTokens, ...descriptionTokens]);
  const frontmatterPhrases = phraseTokens;

  const scored: SuggestedLinkInfo[] = [];
  for (const note of notes) {
    if (existingLinkedIds.has(note.id)) {
      continue;
    }
    if (note.externalFilePath && isExternalSystemFolderPath(note.folderPath)) {
      continue;
    }

    if (outgoingLinkedIds.has(note.id)) {
      scored.push({
        noteId: note.id,
        title: note.title,
        folderPath: note.folderPath,
        updatedAt: note.updatedAt,
        suggestionScore: Number.MAX_SAFE_INTEGER,
        suggestionReason: 'Linked from this note'
      });
      continue;
    }

    let score = 0;
    // Same folder is the weakest signal: it can boost a match but never carry
    // one on its own.
    const sharesFolderBranch = sharesNonRootFolderBranch(note.folderPath, activeNote.folderPath);

    const noteTitleSignal = buildTitleTopicSignal(note.title);
    const noteContentSignal = buildContentTopicSignal(note.title, note.contentSignalText);
    const bothHaveContentSignal = activeContentSignal.tokens.size + activeContentSignal.phrases.size > 0 &&
      noteContentSignal.tokens.size + noteContentSignal.phrases.size > 0;

    const bodyPhraseOverlap = collectPhraseOverlap(activeContentSignal.phrases, noteContentSignal.phrases);
    const bodyTokenOverlap = collectTokenOverlap(activeContentSignal.tokens, noteContentSignal.tokens);
    const activeAnchorTokens = new Set([...activeTitleSignal.tokens, ...tagsTokens]);
    const bodyPhraseHasTopicSupport = (phrase: string): boolean => {
      const phraseTokens = phrase.split(' ');
      const activeSupportCount = phraseTokens.filter((token) => activeAnchorTokens.has(token)).length;
      const noteTitleSupportCount = phraseTokens.filter((token) => noteTitleSignal.tokens.has(token)).length;
      return activeSupportCount >= 2 || noteTitleSupportCount >= 2;
    };
    const bodyPhraseStrength = (phrase: string): number => {
      const phraseTokens = phrase.split(' ');
      const activeTitleSupport = phraseTokens.filter((token) => activeTitleSignal.tokens.has(token)).length;
      const activeTagSupport = phraseTokens.filter((token) => tagsTokens.has(token)).length;
      const noteTitleSupport = phraseTokens.filter((token) => noteTitleSignal.tokens.has(token)).length;
      const repeatedSupport =
        (activeContentSignal.phraseCounts.get(phrase) ?? 0) +
        (noteContentSignal.phraseCounts.get(phrase) ?? 0);

      return (activeTitleSignal.phrases.has(phrase) ? 6 : 0) +
        (noteTitleSignal.phrases.has(phrase) ? 6 : 0) +
        (frontmatterPhrases.has(phrase) ? 4 : 0) +
        activeTitleSupport * 3 +
        noteTitleSupport * 3 +
        activeTagSupport * 2 +
        repeatedSupport;
    };
    const sharedBodyTopicPhrases = bodyPhraseOverlap.filter((phrase) => {
      if (hasRepeatedPhraseToken(phrase)) {
        return false;
      }
      const repeatedInBody =
        (activeContentSignal.phraseCounts.get(phrase) ?? 0) > 1 ||
        (noteContentSignal.phraseCounts.get(phrase) ?? 0) > 1;
      return repeatedInBody ||
        activeTitleSignal.phrases.has(phrase) ||
        noteTitleSignal.phrases.has(phrase) ||
        frontmatterPhrases.has(phrase) ||
        bodyPhraseHasTopicSupport(phrase);
    }).sort((left, right) => {
      return bodyPhraseStrength(right) - bodyPhraseStrength(left) || left.localeCompare(right);
    });
    const hasSharedBodyTopic = sharedBodyTopicPhrases.length > 0;
    if (hasSharedBodyTopic) {
      score += BODY_PHRASE_BASE_SCORE +
        Math.min(BODY_PHRASE_MATCH_SCORE * sharedBodyTopicPhrases.length, BODY_PHRASE_MATCH_SCORE * 3);
    }

    if (hasSharedBodyTopic && bodyTokenOverlap.length >= BODY_TOKEN_MIN_OVERLAP) {
      score += BODY_TOKEN_OVERLAP_BOOST;
    }

    const titlePhraseOverlap = collectPhraseOverlap(activeTitleSignal.phrases, noteTitleSignal.phrases);
    const titleTokenOverlap = collectTokenOverlap(activeTitleSignal.tokens, noteTitleSignal.tokens);
    if (titlePhraseOverlap.length > 0 || titleTokenOverlap.length >= 2) {
      score += TITLE_TOPIC_SCORE;
    }

    const frontmatterPhraseOverlap = [
      ...new Set([
        ...collectPhraseOverlap(frontmatterPhrases, noteTitleSignal.phrases),
        ...collectPhraseOverlap(frontmatterPhrases, noteContentSignal.phrases)
      ])
    ];
    const frontmatterTokenOverlap = [
      ...new Set([
        ...collectTokenOverlap(frontmatterTokens, noteTitleSignal.tokens),
        ...collectTokenOverlap(frontmatterTokens, noteContentSignal.tokens)
      ])
    ];
    const frontmatterOverlapTokens = compactTopicMatches([
      ...frontmatterPhraseOverlap,
      ...frontmatterTokenOverlap
    ]).sort((left, right) => right.length - left.length || left.localeCompare(right));
    score += Math.min(
      FRONTMATTER_OVERLAP_SCORE_CAP,
      frontmatterPhraseOverlap.length * 2 + frontmatterTokenOverlap.length
    );

    if (sharesFolderBranch) {
      score += FOLDER_SCORE;
    }

    if (bothHaveContentSignal && !hasSharedBodyTopic) {
      continue;
    }
    if (score < minScore) {
      continue;
    }

    const suggestionReason = (() => {
      if (hasSharedBodyTopic) {
        return `Shared body topic: ${compactBodyTopicPhrases(sharedBodyTopicPhrases)[0] ?? sharedBodyTopicPhrases[0]}`;
      }
      if (titlePhraseOverlap.length > 0) {
        return `Similar title: ${titlePhraseOverlap.slice(0, 2).join(', ')}`;
      }
      if (titleTokenOverlap.length >= 2) {
        return `Similar title: ${titleTokenOverlap.slice(0, 2).join(', ')}`;
      }
      if (frontmatterOverlapTokens.length > 0) {
        return `Shared frontmatter: ${frontmatterOverlapTokens.slice(0, 2).join(', ')}`;
      }
      if (sharesFolderBranch) {
        return 'Same folder';
      }
      return 'Related note';
    })();

    scored.push({
      noteId: note.id,
      title: note.title,
      folderPath: note.folderPath,
      updatedAt: note.updatedAt,
      suggestionScore: score,
      suggestionReason
    });
  }

  return scored
    .sort((a, b) => {
      const updatedAtA = a.updatedAt ?? 0;
      const updatedAtB = b.updatedAt ?? 0;
      if (b.suggestionScore !== a.suggestionScore) {
        return b.suggestionScore - a.suggestionScore;
      }
      if (updatedAtB !== updatedAtA) {
        return updatedAtB - updatedAtA;
      }
      return a.title.localeCompare(b.title);
    })
    .slice(0, Math.max(0, limit));
};

// ── Components ───────────────────────────────────────────────────────────────

function LinkItem({ link, onClick, suggestionReason }: LinkItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-reason={suggestionReason ?? undefined}
      className={cn(
        'flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left',
        'text-xs text-ink-muted hover:bg-border-subtle/60 hover:text-ink-default',
        'transition-colors duration-100'
      )}
    >
      <FileText className="h-3.5 w-3.5 shrink-0 opacity-50" />
      <span className="min-w-0 truncate">{link.title}</span>
    </button>
  );
}

export function LinksSection({
  activeNoteId,
  onNavigateToNote,
  activeFrontmatter,
  showDivider = false,
  noteIntelligenceEnabled
}: LinksSectionProps) {
  const [activeTab, setActiveTab] = useAtom(linksTabAtom);
  const activeNotes = useAtomValue(suggestedLinkCandidatesAtom);

  const linkData = useAtomValue(noteLinksAtom(activeNoteId ?? '__no-note__'));
  const links = linkData ?? { outgoing: [], incoming: [] };
  const suggestedLinks = React.useMemo(
    () => buildSuggestedLinks(activeNoteId, activeNotes, links, { activeFrontmatter }),
    [activeFrontmatter, activeNoteId, activeNotes, links]
  );

  const hasBacklinks = links.incoming.length > 0;
  const hasSuggestedLinks = suggestedLinks.length > 0;
  const relatedNotesEnabled = noteIntelligenceEnabled !== false;

  const tabs = React.useMemo<LinksTabConfig[]>(() => {
    const next: LinksTabConfig[] = [];
    if (hasBacklinks) {
      next.push({
        id: 'backlinks',
        label: 'Backlinks',
        Icon: ArrowBigLeft,
        items: links.incoming
      });
    }
    if (relatedNotesEnabled && hasSuggestedLinks) {
      next.push({
        id: 'suggested-links',
        label: 'Related Notes',
        Icon: Link2,
        items: suggestedLinks
      });
    }
    return next;
  }, [hasBacklinks, hasSuggestedLinks, links.incoming, relatedNotesEnabled, suggestedLinks]);

  // Keep selection resilient when some tab categories are unavailable for a note.
  const effectiveTab = React.useMemo<LinksTabType>(() => {
    if (tabs.some((tab) => tab.id === activeTab)) {
      return activeTab;
    }
    return tabs[0]?.id ?? 'backlinks';
  }, [activeTab, tabs]);

  const activeTabConfig = React.useMemo(
    () => tabs.find((tab) => tab.id === effectiveTab) ?? null,
    [effectiveTab, tabs]
  );
  const displayedItems = React.useMemo<NoteLinkInfo[]>(() => {
    if (!activeTabConfig) {
      return [];
    }
    return activeTabConfig.items;
  }, [activeTabConfig]);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = React.useState(false);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setIsOverflowing(el.scrollHeight > el.clientHeight);
  }, [displayedItems.length]);

  // Don't render anything if no note selected or no tabs have content
  if (!activeNoteId || tabs.length === 0 || !activeTabConfig) {
    return null;
  }

  return (
    <div className="flex flex-col">
      {/* Divider - only shown when section has content */}
      {showDivider && <div className="mx-panel-inset -mt-panel-section-gap mb-panel-section-gap h-px shrink-0 bg-border-subtle" />}

      {/* Section header */}
      <div className="sticky top-0 z-10 bg-surface-notes-list px-panel-inset pt-2 pb-2">
        <div className="flex h-7 w-full items-center rounded-lg border border-surface-glass-border bg-surface-glass p-0.5 text-caption">
          {tabs.length > 1 ? (
            tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex h-full flex-1 items-center justify-center gap-1 rounded-md px-2 font-normal transition-all focus-visible:outline-none',
                  effectiveTab === tab.id
                    ? 'bg-surface-raised-card text-ink-default shadow-sm'
                    : 'text-ink-muted hover:bg-surface-raised-control/50 hover:text-ink-default'
                )}
              >
                <tab.Icon className={cn('h-3 w-3', effectiveTab === tab.id ? 'text-ink-muted' : 'text-ink-subtle')} />
                <span>{tab.label}</span>
              </button>
            ))
          ) : (
            <div className="flex h-full flex-1 items-center justify-center gap-1 rounded-md bg-surface-raised-card px-2 font-normal text-ink-default shadow-sm">
              <activeTabConfig.Icon className="h-3 w-3 text-ink-subtle" />
              <span>{activeTabConfig.label}</span>
            </div>
          )}
        </div>
      </div>

      {/* Links list — fixed-height scroll area sized for three rows plus padding, with clipped scrolling. */}
      <div className="relative">
        <div ref={scrollRef} className="sidebar-scroll min-h-20 max-h-20 overflow-y-auto px-panel-inset pb-2">
          <div className="space-y-0">
            {displayedItems.map((link) => (
              <LinkItem
                key={link.noteId}
                link={link}
                onClick={() => onNavigateToNote(link.noteId)}
                suggestionReason={
                  effectiveTab === 'suggested-links'
                    ? (link as SuggestedLinkInfo).suggestionReason
                    : undefined
                }
              />
            ))}
          </div>
        </div>
        {isOverflowing && (
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-surface-notes-list to-surface-transparent" />
        )}
      </div>
    </div>
  );
}

export default LinksSection;
