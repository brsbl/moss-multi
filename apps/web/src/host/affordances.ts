// The hide registry (A§9): every moss affordance the web withholds, with the vendored sites that read it.
// An entry either cannot work in a browser (PRODUCT's named set and the same rule, deviations 3, 4 and 7) or is
// `staged` until milestone M lands its backend; staging expires with that milestone (BUILDPLAN conventions).
// Render sites call `hidden(id)` through moss-multi seams; affordances.test.ts checks both directions.

/** Where pristine moss renders an affordance, so a journey can open that surface and find it absent. */
export type Surface =
  | 'shell' // the signed-in shell with nothing opened
  | 'folder-actions' // the notes panel's folder actions menu
  | 'settings' // the Settings dialog
  | 'note-menu' // a notes-list row's context menu
  | 'note-top-bar' // an open note's top bar
  | 'note-more-menu' // an open note's "More actions" menu
  | 'title' // an open note's empty title
  | 'editor-toolbar' // the floating selection toolbar
  | 'slash-menu' // the editor's "/" menu
  | 'browser-split' // the in-app browser's header
  | 'actions-panel' // an open note's actions panel ("Show actions panel")
  | 'block-toolbar' // a hovered code, chart, sketch or media block's toolbar
  | 'comment-popover'; // an open comment thread

export interface Probe {
  surface: Surface;
  /** A selector that matches the affordance in pristine moss's DOM. */
  selector: string;
  /** Narrows `selector` to elements whose text is exactly this. */
  text?: string;
}

export interface Affordance {
  id: string;
  /** Vendored files (under vendor/moss/packages) whose render sites read `hidden(id)`. */
  sites: string[];
  reason: string;
  /** The ruling that withholds it: a PRODUCT section, restart ruling, A§ or BUILDPLAN task. */
  cite: string;
  /** Staged: hidden until milestone M lands the backend, then the entry and its reads are removed (A§9). */
  staged?: number;
  probes: Probe[];
}

const R = 'desktop/src/renderer';
const MENU_ITEM = '[role="menuitem"]';
// A slash-menu command's label (SlashCommandPlugin renders each command as a `button[data-index]`).
const SLASH_ITEM = 'button[data-index] .text-sm.font-medium';

export const AFFORDANCES = [
  // PRODUCT's named set (P:Agents).
  {
    id: 'share-with-agent',
    sites: [`${R}/panels/CanvasAreaContent.tsx`],
    reason: "It copies a prompt naming the note's local file path for a desktop agent; a server note has none.",
    cite: 'P:Agents',
    probes: [{ surface: 'note-top-bar', selector: 'button[aria-label="Share with Agent"]' }],
  },
  {
    id: 'ai-run-action',
    sites: [`${R}/App.tsx`, `${R}/panels/BrowserSplitPane.tsx`, `${R}/editor/components/CommentUIWrapper.tsx`, `${R}/panels/CanvasAreaContent.tsx`],
    reason: 'In-app agent execution is out of scope (`agent.execute` rejects): the toolbar action, ⌘K and "Send page to Agent" go together; the panel stays, inert.',
    cite: 'P:Agents',
    probes: [
      { surface: 'editor-toolbar', selector: 'button[aria-label="Open command palette"]' },
      { surface: 'browser-split', selector: '[data-browser-actions-cluster] button[aria-label^="Send page to Agent"]' },
    ],
  },
  {
    id: 'reveal-in-finder',
    sites: [`${R}/panels/NotesListPanelContent.tsx`, `${R}/panels/TrashedNotesPanelContent.tsx`],
    reason: 'There is no Finder and no local file to reveal.',
    cite: 'P:Agents',
    probes: [{ surface: 'note-menu', selector: MENU_ITEM, text: 'Open in Finder' }],
  },
  {
    id: 'open-directory',
    sites: [`${R}/panels/NotesListPanelContent.tsx`],
    reason: '"Open..." imports a local folder through a native dialog the page cannot show.',
    cite: 'P:Agents',
    probes: [{ surface: 'folder-actions', selector: MENU_ITEM, text: 'Open...' }],
  },
  {
    id: 'settings-workspace-location',
    sites: [`${R}/components/SettingsModal.tsx`],
    reason: 'The workspace lives on the server; the vault switcher replaces the location picker.',
    cite: 'P:Agents; A§9 appConfig',
    probes: [{ surface: 'settings', selector: '[role="dialog"] span', text: 'Workspace Location' }],
  },
  {
    id: 'settings-default-md-editor',
    sites: [`${R}/components/SettingsModal.tsx`],
    reason: 'A web page cannot own the .md file association.',
    cite: 'P:Agents',
    probes: [{ surface: 'settings', selector: '[role="dialog"] span', text: 'Default Markdown Editor' }],
  },
  {
    id: 'settings-connected-folders',
    sites: [`${R}/components/SettingsModal.tsx`],
    reason: 'Granting a local directory needs an OS picker and a filesystem the page cannot reach.',
    cite: 'P:Agents',
    probes: [{ surface: 'settings', selector: '[role="dialog"] span', text: 'Connected Folders' }],
  },
  {
    id: 'create-note-shortcut-label',
    sites: ['shared/src/components/layout/NotesListPanel.tsx'],
    reason: 'Browsers keep ⌘N for a new window, so the chip advertises a shortcut the page never receives; "+ Note" stays.',
    cite: 'P:Agents; deviation 4',
    probes: [{ surface: 'shell', selector: 'button[aria-label="Create new note"] > span:has(kbd)' }],
  },
  {
    id: 'settings-note-intelligence',
    sites: [`${R}/components/SettingsModal.tsx`],
    reason: 'Automatic property inference and related-note suggestions require desktop background agents; manual Properties works independently.',
    cite: 'P:Agents; T1.4',
    probes: [{ surface: 'settings', selector: '[role="dialog"] span', text: 'Note Intelligence' }],
  },
  // The same "cannot work on the web" rule.
  {
    id: 'title-shortcut-label',
    sites: [`${R}/panels/CanvasAreaContent.tsx`],
    reason: 'Browsers keep ⌘T for a new tab.',
    cite: 'deviation 4; S-ren §0.10',
    probes: [{ surface: 'title', selector: '.tracking-title kbd' }],
  },
  {
    id: 'emoji-panel',
    sites: [`${R}/editor/slash-commands/registry.ts`],
    reason: '`/emoji` opens the OS emoji panel; the web has no API for it.',
    cite: 'deviation 4',
    probes: [{ surface: 'slash-menu', selector: SLASH_ITEM, text: 'Emoji' }],
  },
  {
    id: 'browser-back-forward',
    sites: [`${R}/panels/BrowserSplitPane.tsx`],
    reason: "A cross-origin iframe exposes no history to its embedder.",
    cite: 'R4; deviation 7',
    probes: [{ surface: 'browser-split', selector: '[data-browser-header-content] button[aria-label="Go back"], [data-browser-header-content] button[aria-label="Go forward"]' }],
  },
  {
    id: 'browser-find',
    sites: [`${R}/panels/BrowserSplitPane.tsx`],
    reason: 'A cross-origin iframe cannot be searched by its embedder.',
    cite: 'R4; deviation 7',
    probes: [{ surface: 'browser-split', selector: '[data-browser-actions-cluster] button[aria-label="Search in browser"]' }],
  },
  // Staged: the entry points stay hidden until their backend lands, so no live control ever 404s.
  {
    id: 'comment-edit-delete',
    sites: [`${R}/editor/components/CommentPopover.tsx`],
    reason: 'Editing and deleting a comment must be the author\'s alone, and a root delete must promote its oldest reply; that server rule lands with T4.4, so the thread\'s Edit and Delete controls wait for it.',
    cite: 'T4.4; comments.md §12',
    staged: 4,
    probes: [{ surface: 'comment-popover', selector: '.moss-comment-popover button[aria-label="Delete thread"]' }],
  },
  {
    id: 'comment-images',
    sites: [`${R}/editor/components/CommentTextInput.tsx`],
    reason: 'Commenters cannot upload (PRODUCT reserves uploads to editors), and a comment image needs per-URL media admission the comment API does not take; the thread text works without it.',
    cite: 'comments.md §14 decision 2; P2 #10',
    probes: [{ surface: 'comment-popover', selector: '.moss-comment-popover button[aria-label="Attach image"]' }],
  },
] as const satisfies readonly Affordance[];

export type AffordanceId = (typeof AFFORDANCES)[number]['id'];

const IDS: ReadonlySet<string> = new Set(AFFORDANCES.map((entry) => entry.id));

/** True when the web withholds the affordance; render sites read it through moss-multi seams. */
export function hidden(id: AffordanceId): boolean {
  return IDS.has(id);
}
