// The DOM contract (A§19): names the product publishes and e2e/lib and the QA prelude read.

/** `<meta name="moss-build" content="<commit>:<bundleHash>">`, rendered by the Worker's SSR. */
export const BUILD_META = 'moss-build';

/** `html[data-client-build="<commit>:<clientHash>"]`, stamped by the client entry before React mounts. */
export const CLIENT_BUILD_ATTR = 'data-client-build';

/**
 * On `html`: `booting` in the SSR document; `ready` once moss's shell renders, or once /login's card accepts input;
 * `degraded` while the session lookup keeps failing, retrying in place (R10).
 */
export const APP_STATE_ATTR = 'data-app-state';
export const APP_STATES = ['booting', 'ready', 'degraded'] as const;
export type AppState = (typeof APP_STATES)[number];

/** Each editor pane root carries both. */
export const EDITOR_PANE_ATTR = 'data-editor-pane';
export const DOC_ID_ATTR = 'data-doc-id';

/** On the pane root. `live` only after first sync and an editable root, set in one effect. */
export const DOC_STATE_ATTR = 'data-doc-state';
export const DOC_STATES = ['binding', 'retrying', 'live', 'offline', 'terminal'] as const;
export type DocState = (typeof DOC_STATES)[number];

/** On the title field and the body root. While not `live`, the element is non-focusable. */
export const TITLE_BINDING_ATTR = 'data-title-binding';
export const BODY_BINDING_ATTR = 'data-body-binding';
export const BINDING_STATES = ['unbound', 'live', 'readonly', 'terminal'] as const;
export type BindingState = (typeof BINDING_STATES)[number];

/** On the body root: +1 on every Lexical editor creation (remount detector). */
export const EDITOR_GENERATION_ATTR = 'data-editor-generation';

/** On the pane: `0` or `1`. */
export const SYNC_UNACKED_ATTR = 'data-sync-unacked';

/** On the connection indicator, in the pane's top bar. */
export const CONNECTION_ATTR = 'data-connection';
export const CONNECTION_STATES = ['online', 'reconnecting', 'offline'] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/** On the pane. */
export const TERMINAL_REASON_ATTR = 'data-terminal-reason';
export const TERMINAL_REASONS = ['deleted', 'revoked', 'session-ended', 'unavailable', 'conn-limit'] as const;
export type TerminalReason = (typeof TERMINAL_REASONS)[number];

/** The reserved notice band under each pane's top bar (A§10.5): in flow, empty and zero-height until it has news. */
export const NOTICE_BAND_ATTR = 'data-notice-band';

/**
 * The banner in the notice band: `retrying` while a first sync is late, `offline` while a synced doc is not
 * delivering, `halted` after a refused write stopped the doc, or the terminal reason.
 */
export const CONNECTION_BANNER_ATTR = 'data-connection-banner';
export const CONNECTION_BANNERS = ['retrying', 'offline', 'halted', ...TERMINAL_REASONS] as const;
export type ConnectionBanner = (typeof CONNECTION_BANNERS)[number];

/** On the pane: the effective role. */
export const ROLE_ATTR = 'data-role';

/** Presence: the pile in the top bar holds one chip per other client (zero when alone). */
export const PRESENCE_PILE_ATTR = 'data-presence-pile';
export const PRESENCE_CHIP_ATTR = 'data-presence-chip';
export const CLIENT_ID_ATTR = 'data-client-id';
export const PRINCIPAL_ID_ATTR = 'data-principal-id';
export const PRESENCE_COLOR_ATTR = 'data-presence-color';
export const SELF_ATTR = 'data-self';

/** Remote cursor overlay parts, each with `data-principal-id`. */
export const REMOTE_CARET_ATTR = 'data-remote-caret';
export const REMOTE_SELECTION_ATTR = 'data-remote-selection';
export const REMOTE_LABEL_ATTR = 'data-remote-label';

/** Every web-added control; it must sit inside `[data-top-bar]` or the notes-panel header. */
export const COLLAB_CHROME_ATTR = 'data-collab-chrome';
export const TOP_BAR_ATTR = 'data-top-bar';

/** The scrollable editor region: the floating-chrome detector's target. */
export const EDITOR_CANVAS_ATTR = 'data-editor-canvas';

/** DS menus, dialogs, popovers, sheets and the phone notes overlay: the floating detector's allowlist. */
export const OVERLAY_SURFACE_ATTR = 'data-overlay-surface';

/** moss's own floating selection toolbar. */
export const FLOATING_TOOLBAR_ATTR = 'data-floating-selection-toolbar';

/** The single refusal announcer, a visible live region. */
export const INPUT_REFUSAL_ATTR = 'data-input-refusal';

/** Notes-list rows, with `data-doc-id` and `data-active`. */
export const SIDEBAR_ROW_ATTR = 'data-sidebar-row';
export const ACTIVE_ATTR = 'data-active';

/** Trash-view rows, with `data-doc-id` (T2.3). */
export const TRASH_ROW_ATTR = 'data-trash-row';

/** The retention notice on a note open in the Trash view; its words come from protocol/retention.ts. */
export const RETENTION_NOTICE_ATTR = 'data-retention-notice';

/** Suggest mode (docs/design/suggestions.md §5, §8): the pane's mode, the role-locked chip, the toolbar toggle, the
 * band offering back text a closed suggestion could not keep, and painted suggestion markers. */
export const EDIT_MODE_ATTR = 'data-edit-mode';
export const EDIT_MODES = ['edit', 'suggest', 'review'] as const;
export type EditMode = (typeof EDIT_MODES)[number];
export const SUGGEST_CHIP_ATTR = 'data-suggest-chip';
export const SUGGEST_TOGGLE_ATTR = 'data-suggest-toggle';
export const SUGGEST_UNSAVED_ATTR = 'data-suggest-unsaved';
export const SUGGEST_MARK_ATTR = 'data-suggest-mark';
/** On the pane: suggest frames sent and refused by this pane's fork (test readouts). */
export const SUGGEST_SENT_ATTR = 'data-suggest-sent';
export const SUGGEST_REFUSED_ATTR = 'data-suggest-refused';

/** Review UI (docs/design/suggestions.md §8): the top-bar button with its open count, its panel, and each card with
 * its record id and status; the active card (opened from a painted suggestion) carries `data-suggestion-active`. */
export const SUGGESTIONS_BUTTON_ATTR = 'data-suggestions-button';
export const SUGGESTIONS_PANEL_ATTR = 'data-suggestions-panel';
export const SUGGESTION_CARD_ATTR = 'data-suggestion-card';
export const SUGGESTION_ID_ATTR = 'data-suggestion-id';
export const SUGGESTION_STATUS_ATTR = 'data-suggestion-status';
export const SUGGESTION_ACTIVE_ATTR = 'data-suggestion-active';
/** Each row of a card: `insert`, `delete` or `change`. */
export const SUGGESTION_ROW_ATTR = 'data-suggestion-row';

/** The body editor root Lexical renders. */
export const LEXICAL_EDITOR_SELECTOR = '[data-lexical-editor="true"]';

/** The doc socket path; invariant 3 counts only these. */
export const DOC_SOCKET_PATH = '/parties/doc-d-o/';

/** History (A§14, T6.3): the top-bar button, the view occupying the pane (`loading`, `error`, `empty` or `ready`),
 * each version row (its kind, with `data-version-id`), the selected version's content (`view` or `diff`) and the
 * version's whole title inside it. */
export const HISTORY_BUTTON_ATTR = 'data-history-button';
export const HISTORY_VIEW_ATTR = 'data-history-view';
export const HISTORY_VIEW_STATES = ['loading', 'error', 'empty', 'ready'] as const;
export type HistoryViewState = (typeof HISTORY_VIEW_STATES)[number];
export const VERSION_ROW_ATTR = 'data-version-row';
export const VERSION_ID_ATTR = 'data-version-id';
export const VERSION_CONTENT_ATTR = 'data-version-content';
export const VERSION_TITLE_ATTR = 'data-version-title';
