// The viewer's public contract (API version 1). Everything here is plain data or a function the host supplies.
// Later 1.x releases only add, each addition behind a feature string in MOSS_VIEWER_INFO.features and viewer.json.

export type MossViewerTheme = 'light' | 'dark';

/** A feature string a 1.x release adds: `selection-1` (`handle.selection()`), `share-with-agent-1` (`services.shareWithAgent`). */
export type MossViewerFeature = string;

/** The built viewer's identity; equal to viewer.json's `api`, `version` and `features`. */
export interface MossViewerInfo {
  readonly api: 1;
  readonly version: string;
  readonly features: readonly MossViewerFeature[];
}

/**
 * The reader's selection in the note body (feature `selection-1`). Moss markdown has no persisted block ids, so the
 * line range and the heading path are the stable reference.
 */
export interface MossSelection {
  /** The selected plain text as rendered; never a `%%m:` comment marker. */
  text: string;
  /** The selected lines of the note's markdown, as moss's export writes them, comment markers stripped. */
  markdown: string;
  /**
   * 1-based, inclusive lines in the note's markdown file, frontmatter and the `# Title` line counted. They come from
   * moss's own export of the note, which for a file moss wrote is the file as loaded. Inside a list, table or code
   * block they name the items, rows or code lines selected; elsewhere every line of each block the selection touches.
   */
  lines: { start: number; end: number };
  /** The headings over the selection's start, outermost first (a selected heading included). */
  headings: string[];
  /** Each top-level block the selection touches: its node type, its first line, and the innermost heading over it. */
  blocks: { type: string; line: number; heading?: string }[];
}

/** A note a wiki link may name. */
export interface MossViewerNote {
  id: string;
  title: string;
  /** moss's folder path (`Notes/...`), shown in link hover cards. */
  folderPath?: string;
  /** Seconds since the epoch, shown in link hover cards. */
  updatedAt?: number;
  headings?: readonly string[];
}

/** `video` for mp4, webm and mov references (the URL must answer HTTP Range requests), else `image`. */
export type MossViewerAssetKind = 'image' | 'video';

export type MossViewerTarget =
  | { kind: 'note'; noteId: string; heading: string | null }
  | { kind: 'url'; url: string; title: string };

/** Link-card metadata for a web embed or link pill (moss's oEmbed/OpenGraph preview). */
export interface MossViewerUnfurl {
  /** `unavailable` shows moss's unavailable card (a deleted post). */
  status?: 'resolved' | 'unavailable';
  title?: string;
  description?: string;
  providerName?: string;
  authorName?: string;
  /** A preview image reference, resolved through `assetUrl`. */
  image?: string;
  /** A site icon reference, resolved through `assetUrl`. */
  siteIcon?: string;
  /** Height hint, in CSS pixels, for a post frame. */
  height?: number;
}

/** Everything the viewer may reach outside its bundle. It has no other network or storage path. */
export interface MossViewerServices {
  /**
   * A URL the page may load for a media reference as the markdown wrote it (`assets/x.png`, a path or a remote
   * URL), or null for moss's missing-media state.
   */
  assetUrl?(ref: string, kind: MossViewerAssetKind): string | null;
  /** Notes wiki links resolve against: `[[Title]]` by title, `[[Title|id]]` by id. */
  notes?(): readonly MossViewerNote[] | Promise<readonly MossViewerNote[]>;
  /** The reader followed a wiki link or a web link. */
  navigate?(target: MossViewerTarget): void;
  unfurl?(url: string): Promise<MossViewerUnfurl | null>;
  /**
   * The URL of the bundle's `moss-viewer-frame.html`, served by the host with the policy
   * `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:`
   * (loosen `img-src`, `font-src` or `connect-src` only for what notes' HTML may load), and allowed by the page's
   * `frame-src`. With it, HTML blocks run live in `<iframe sandbox="allow-scripts">` loading that URL, an opaque origin
   * that cannot reach the page; without it they show moss's cached screenshot through `assetUrl`, else "Preview
   * unavailable".
   */
  htmlFrameUrl?: string;
  /**
   * Feature `share-with-agent-1`: with this service the viewer shows moss's Share with Agent button above the note,
   * and a press calls it with the current selection (null when nothing in the body is selected). Without it the
   * button stays hidden.
   */
  shareWithAgent?(selection: MossSelection | null): void;
}

export interface MossViewerOptions {
  /** A moss note file: optional frontmatter, the `# Title` line, then the body. */
  markdown?: string;
  /** Or a serialized Lexical editor state of the body (moss's `SerializedEditorState`). */
  state?: unknown;
  /** The title when the file has no leading H1, or the title for `state`. */
  title?: string;
  /** The frontmatter for `state` (raw YAML or parsed); never painted in the canvas, as in moss. */
  frontmatter?: string | Record<string, unknown> | null;
  /** The note's `layout.json` sidecar: table column widths and tab widths. */
  layout?: unknown;
  theme?: MossViewerTheme;
  /** This note's id, so a link back to it navigates to it. */
  noteId?: string;
  services?: MossViewerServices;
}

export interface MossViewerHandle {
  readonly title: string;
  readonly frontmatter: Record<string, unknown> | null;
  /** Settles when the body has rendered. */
  readonly ready: Promise<void>;
  setTheme(theme: MossViewerTheme): void;
  unmount(): void;
  /** Feature `selection-1`: the reader's selection in the body, or null when it is collapsed or outside the body. */
  selection(): MossSelection | null;
}
