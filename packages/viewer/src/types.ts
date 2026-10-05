// The viewer's public contract (API version 1). Everything here is plain data or a function the host supplies.

export type MossViewerTheme = 'light' | 'dark';

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
  htmlFrameUrl?: string;
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
}
