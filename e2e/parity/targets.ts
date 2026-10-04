// Parity targets (A§20, S-test §5.2): a moss Ladle story at the pin against the built Worker in the same state.
// Targets grow per milestone; M0 is the shell.

export type Theme = 'light' | 'dark';

export interface Target {
  id: string;
  /** Ladle story id, checked against the oracle's meta.json. */
  story: string;
  /**
   * The candidate's state.
   * - `fresh`: a new principal's Home vault, as the product serves it.
   * - `story-listing`: the story bridge's own `notes.getAll()`, served as this principal's `GET /api/workspace`;
   *   each story note is created as a real doc with its title, the story's first note opens through `/d/$docId`,
   *   then the note the oracle shows opens from the sidebar. Titles cannot be authored through the UI until M1, so
   *   the listing is the one fixture; everything rendered from it is the built Worker's.
   */
  seed: 'fresh' | 'story-listing';
  /** Match editor focus on both sides; deviation 10 hides the candidate toolbar on blur. */
  focusEditor: boolean;
  /** Web chrome to paint out on both sides (sanctioned collab chrome only). */
  masks: string[];
  /** Largest diff share, in percent. */
  floor: number;
  /** Largest 8-connected diff blob, in device px. */
  maxBlob: number;
}

export const TARGETS: Target[] = [
  // Compare the default shell with editing controls visible; j01 separately gates deviation 10 on blur.
  // Mask only web controls: Share and connection in the top bar, and the vault selector in either shell.
  { id: 'shell-default', story: 'app--default', seed: 'story-listing', focusEditor: true, masks: ['[data-collab-chrome]'], floor: 0.05, maxBlob: 16 },
  { id: 'shell-empty', story: 'app--empty-notes', seed: 'fresh', focusEditor: false, masks: ['[data-collab-chrome]'], floor: 0.05, maxBlob: 16 },
];

export const THEMES: Theme[] = ['light', 'dark'];

/** Ladle's STORY_NOW_ISO (stories/utils/story-data.tsx); both sides run on it so relative times match. */
export const STORY_NOW = '2025-01-09T12:00:00.000Z';

/** The crop: moss's AppShell root, so Ladle's own chrome never enters the comparison. */
export const CROP = '[data-moss-app-shell]';

/** Faces main.tsx loads; each must load on both sides before capture (L§4.19: audit the oracle first). */
export const FONT_FACES = [
  '300 16px "Inter Variable"',
  '400 16px "Inter Variable"',
  '500 16px "Inter Variable"',
  '600 16px "Inter Variable"',
  '700 16px "Inter Variable"',
  'italic 400 16px "Inter Variable"',
  '400 13px "JetBrains Mono Variable"',
  '400 13px "JetBrains Mono"',
  '500 13px "JetBrains Mono"',
  '400 16px "Charter"',
  '700 16px "Charter"',
  'italic 400 16px "Charter"',
  'italic 700 16px "Charter"',
];
