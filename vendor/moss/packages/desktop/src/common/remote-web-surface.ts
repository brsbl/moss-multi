// ported-from: packages/desktop/src/common/remote-web-surface.ts @ 762abb777
export type RemoteWebSurfaceMode = 'card' | 'fullscreen' | 'split';

export interface RemoteWebSurfaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RemoteWebSurfaceCreateInput {
  id: string;
  noteId: string;
  nodeKey: string;
  mode: RemoteWebSurfaceMode;
  navigationRequestId?: number;
  url: string;
  title: string;
  bounds: RemoteWebSurfaceBounds;
  commandPaletteShortcutEnabled?: boolean;
}

export interface RemoteWebSurfaceBoundsInput {
  id: string;
  bounds: RemoteWebSurfaceBounds;
  visible?: boolean;
}

export interface RemoteWebSurfaceDestroyInput {
  id: string;
}

export interface RemoteWebSurfaceMenuInput extends RemoteWebSurfaceDestroyInput {
  x: number;
  y: number;
}

export interface RemoteWebSurfaceFindInput {
  id: string;
  text: string;
  forward?: boolean;
  findNext?: boolean;
}

export interface RemoteWebSurfaceDestroyForNoteInput {
  noteId: string;
}

export interface RemoteWebSurfaceNavigationState {
  id: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** Bounding rect of the active selection, in CSS px relative to the surface viewport. */
export interface RemoteWebSurfaceSelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Text-selection state reported by the scoped selection preload running inside
 * a native browser surface. Pushed to the renderer so Moss chrome can show a
 * selection toolbar. `rect` is null when there is no usable selection geometry.
 */
export interface RemoteWebSurfaceSelectionState {
  id: string;
  hasSelection: boolean;
  text: string;
  rect: RemoteWebSurfaceSelectionRect | null;
}

export interface RemoteWebSurfaceFindResultState {
  id: string;
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}

export interface RemoteWebSurfaceFindShortcutState {
  id: string;
}

export interface RemoteWebSurfaceCommandPaletteShortcutState {
  id: string;
  selectionText: string;
  sourceUrl: string;
}

export interface RemoteWebSurfaceFocusedState {
  id: string;
}

export interface RemoteWebSurfaceResult {
  ok: boolean;
  errorCode?: 'invalid-input' | 'window-not-found' | 'unsupported' | 'unsafe-url' | 'load-failed';
  errorMessage?: string;
  requestId?: number;
}

export interface RemoteWebSurfaceSavePdfResult extends RemoteWebSurfaceResult {
  canceled?: boolean;
  filePath?: string;
  previewWindowId?: number;
}
