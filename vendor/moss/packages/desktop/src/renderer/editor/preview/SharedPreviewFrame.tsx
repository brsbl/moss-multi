// ported-from: packages/desktop/src/renderer/editor/preview/SharedPreviewFrame.tsx @ 762abb777
/**
 * Shared block-preview frame for media-family preview cards.
 *
 * Owns the surface/chrome/layout that `moss-html` previews and webpage embeds
 * both need: the block decorator scaffold (`group/decorator`, gap cursors,
 * selection outline via `BlockNodeShell`), a fixed-size `editor-block-surface`,
 * and the layered, clipped preview viewport that stacks header controls, the
 * static preview, the live/interactive layer, loading/error layers, an
 * activation affordance, and an optional compact footer.
 *
 * Feature differences are passed as slots/config — `HtmlBlockquoteNode` and
 * `WebEmbedNode` import this instead of each owning a bespoke card shell. Sizing
 * comes from the shared `moss-html-dimensions` resolvers (no per-feature sizing
 * module); the frame only renders the resolved `frameSize`.
 */
import type { CSSProperties, JSX, ReactNode, Ref } from 'react';
import type { NodeKey } from 'lexical';

import { BLOCK_SURFACE_CLASSNAME, BlockNodeShell } from '../components/media-primitives';

export interface SharedPreviewFrameSize {
  width: number;
  height: number;
}

export interface SharedPreviewFrameProps {
  nodeKey: NodeKey;
  selected: boolean;
  /** Resolved note-frame pixel size (from the shared moss-html resolvers). */
  frameSize: SharedPreviewFrameSize;
  beforeLabel: string;
  afterLabel: string;
  /**
   * Gap-cursor click handler. Omit it (e.g. read-only renders) to hide the
   * paragraph-insertion gap cursors entirely.
   */
  onGapClick?: (position: 'before' | 'after') => (e: React.MouseEvent) => void;

  /** Ref to the outer host element (used as the lightbox anchor + width source). */
  hostRef?: Ref<HTMLDivElement>;
  /** Extra classes for the outer `group/decorator` element (e.g. `my-4`). */
  rootClassName?: string;
  /** Data attributes for the outer element (e.g. `data-web-embed-node`). */
  rootDataAttributes?: Record<string, string>;
  onRootClick?: (e: React.MouseEvent) => void;
  onRootDoubleClick?: (e: React.MouseEvent) => void;
  /** Max-width class for the host (defaults to the prose canvas width). */
  maxWidthClassName?: string;
  /** Alignment/width classes for the fixed preview shell. */
  shellClassName?: string;
  /** Surface class (defaults to the shared `editor-block-surface`). */
  surfaceClassName?: string;
  surfaceStyle?: CSSProperties;
  surfaceSizing?: 'fixed' | 'aspect-video';

  // --- Layered viewport slots (used when `children` is not provided) ---
  viewportRef?: Ref<HTMLDivElement>;
  viewportClassName?: string;
  viewportDataAttributes?: Record<string, string>;
  /** Absolutely-positioned header controls (e.g. `MediaNodeHeader`). */
  headerActions?: ReactNode;
  /** Activation affordance overlay (e.g. click-to-load / live badge). */
  activationBadge?: ReactNode;
  /** Static preview content (image, oEmbed surface, URL card). */
  staticLayer?: ReactNode;
  /** Live/interactive iframe layer (mounted only after activation). */
  interactiveLayer?: ReactNode;
  loadingLayer?: ReactNode;
  errorLayer?: ReactNode;
  /** Extra in-viewport overlays (e.g. fullscreen button). */
  overlay?: ReactNode;
  /** Optional compact metadata/footer rendered below the viewport. */
  footer?: ReactNode;

  /** When provided, replaces the slot-based viewport (e.g. an inline editor). */
  children?: ReactNode;
  /** Rendered after the surface, inside the outer decorator (e.g. a lightbox). */
  afterSurface?: ReactNode;
}

export function SharedPreviewFrame({
  nodeKey,
  selected,
  frameSize,
  beforeLabel,
  afterLabel,
  onGapClick,
  hostRef,
  rootClassName,
  rootDataAttributes,
  onRootClick,
  onRootDoubleClick,
  maxWidthClassName = 'max-w-canvas-prose',
  shellClassName = 'mx-auto',
  surfaceClassName = BLOCK_SURFACE_CLASSNAME,
  surfaceStyle,
  surfaceSizing = 'fixed',
  viewportRef,
  viewportClassName = 'relative h-full overflow-hidden bg-ink-inverse',
  viewportDataAttributes,
  headerActions,
  activationBadge,
  staticLayer,
  interactiveLayer,
  loadingLayer,
  errorLayer,
  overlay,
  footer,
  children,
  afterSurface
}: SharedPreviewFrameProps): JSX.Element {
  return (
    <div
      className={`group/decorator relative ${rootClassName ?? ''}`.trimEnd()}
      data-block-decorator-key={nodeKey}
      onClick={onRootClick}
      onDoubleClick={onRootDoubleClick}
      {...rootDataAttributes}
    >
      <div ref={hostRef} className={`mx-auto w-full ${maxWidthClassName}`}>
        <BlockNodeShell
          selected={selected}
          beforeLabel={beforeLabel}
          afterLabel={afterLabel}
          onGapClick={onGapClick}
          className={shellClassName}
          style={{ width: `${frameSize.width}px`, maxWidth: '100%' }}
        >
          <div
            className={
              surfaceSizing === 'aspect-video'
                ? `${surfaceClassName} aspect-video`
                : surfaceClassName
            }
            style={{
              ...(surfaceSizing === 'fixed' ? { height: `${frameSize.height}px` } : {}),
              ...surfaceStyle
            }}
          >
            {children ?? (
              <div className="relative h-full overflow-hidden">
                {headerActions}
                <div
                  ref={viewportRef}
                  className={viewportClassName}
                  {...viewportDataAttributes}
                >
                  {activationBadge}
                  {staticLayer}
                  {interactiveLayer}
                  {loadingLayer}
                  {errorLayer}
                  {overlay}
                </div>
                {footer}
              </div>
            )}
          </div>
        </BlockNodeShell>
      </div>
      {afterSurface}
    </div>
  );
}

export default SharedPreviewFrame;
