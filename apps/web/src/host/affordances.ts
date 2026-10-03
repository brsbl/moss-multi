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
  | 'block-toolbar'; // a hovered code, chart, sketch or media block's toolbar

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
    sites: [`${R}/App.tsx`, `${R}/panels/BrowserSplitPane.tsx`],
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
    id: 'new-folder',
    sites: [`${R}/panels/NotesListPanelContent.tsx`],
    reason: 'The folders API lands in M2. With "Open..." also withheld, the folder actions menu has no item, so its trigger goes too.',
    cite: 'T2.2',
    staged: 2,
    probes: [
      { surface: 'folder-actions', selector: MENU_ITEM, text: 'New Folder' },
      { surface: 'shell', selector: 'button[aria-label="Folder actions"]' },
    ],
  },
  {
    id: 'trash',
    sites: [`${R}/panels/NotesPanelFooter.tsx`, `${R}/panels/NotesListPanelContent.tsx`, `${R}/panels/CanvasAreaContent.tsx`, `${R}/App.tsx`],
    reason: 'Trash, restore and the trash list land in M2: the footer Trash view, the note and folder Trash items and ⌘2.',
    cite: 'T2.3',
    staged: 2,
    probes: [
      { surface: 'shell', selector: 'button[aria-label="Trash"]' },
      { surface: 'note-menu', selector: MENU_ITEM, text: 'Trash' },
      { surface: 'note-more-menu', selector: MENU_ITEM, text: 'Trash' },
    ],
  },
  {
    id: 'note-properties',
    sites: ['shared/src/components/layout/ActionsPanelWrapper.tsx'],
    reason: "Properties edits the note's frontmatter, which binds to Y.Text('frontmatter') in M1; a bound note has no save path, so an edit would vanish on reload.",
    cite: 'T1.4; A§10.4',
    staged: 1,
    probes: [{ surface: 'actions-panel', selector: '[data-actions-panel-wrapper] [role="tab"]', text: 'Properties' }],
  },
  {
    id: 'rename-note',
    sites: [`${R}/App.tsx`],
    reason: "Rename focuses the note's title, which stays closed until it binds to Y.Text('title') in M1, so the name typed after it would land nowhere.",
    cite: 'T1.4; R2',
    staged: 1,
    probes: [{ surface: 'note-menu', selector: MENU_ITEM, text: 'Rename' }],
  },
  {
    id: 'duplicate-note',
    sites: [`${R}/App.tsx`],
    reason: 'Duplicate goes through a server endpoint in M1; the bridge refuses content writes.',
    cite: 'T1.8',
    staged: 1,
    probes: [{ surface: 'note-menu', selector: MENU_ITEM, text: 'Duplicate' }],
  },
  {
    id: 'comments',
    sites: [
      `${R}/editor/MarkdownEditor.tsx`, `${R}/editor/nodes/CodeBlockNode.view.tsx`, `${R}/editor/nodes/ChartNode.view.tsx`,
      `${R}/editor/nodes/SketchNode.view.tsx`, `${R}/editor/components/media-primitives.tsx`,
    ],
    reason: "A new comment's thread lives in an atom that only moss's save path persists, and a bound note has none, so its text would vanish on reload. Comments become shared data in M4: the toolbar button, ⌘⇧A and the block buttons go together.",
    cite: 'T4.2; A§13',
    staged: 4,
    probes: [
      { surface: 'editor-toolbar', selector: 'button[aria-label="Add comment"]' },
      { surface: 'block-toolbar', selector: '[data-lexical-decorator] button:has(svg.lucide-sticky-note)' },
    ],
  },
  {
    id: 'media-upload',
    sites: [`${R}/editor/slash-commands/registry.ts`, `${R}/editor/plugins/VideoPastePlugin.tsx`, `${R}/editor/plugins/MediaDropPlugin.tsx`],
    reason: 'Asset upload and remote-image storage land in M3: /media goes, and a pasted or dropped image or video is refused visibly.',
    cite: 'T3.1',
    staged: 3,
    probes: [{ surface: 'slash-menu', selector: SLASH_ITEM, text: 'Media' }],
  },
  {
    id: 'save-as-pdf',
    sites: [`${R}/panels/CanvasAreaContent.tsx`],
    reason: 'Browser print through /pdf-export lands in M3.',
    cite: 'T3.7',
    staged: 3,
    probes: [{ surface: 'note-more-menu', selector: MENU_ITEM, text: 'Save as PDF' }],
  },
  {
    id: 'save-as-markdown',
    sites: [`${R}/panels/CanvasAreaContent.tsx`],
    reason: 'The export download lands in M3.',
    cite: 'T3.7',
    staged: 3,
    probes: [{ surface: 'note-more-menu', selector: MENU_ITEM, text: 'Save as Markdown' }],
  },
] as const satisfies readonly Affordance[];

export type AffordanceId = (typeof AFFORDANCES)[number]['id'];

const IDS: ReadonlySet<string> = new Set(AFFORDANCES.map((entry) => entry.id));

/** True when the web withholds the affordance; render sites read it through moss-multi seams. */
export function hidden(id: AffordanceId): boolean {
  return IDS.has(id);
}
