// ported-from: packages/desktop/stories/editor/HtmlPreviewNode.stories.tsx @ 762abb777
import type { Story } from '@ladle/react';
import {
  Maximize2,
  Pencil,
  RefreshCw,
  Trash2,
  TvMinimalPlay,
  type LucideIcon
} from 'lucide-react';

import '../../src/renderer/editor/MarkdownEditor.css';

export const meta = {
  title: 'Editor/HTML Preview Node'
};

type HtmlPreviewState = 'loading' | 'error';
const skeletonWidths = ['80%', '100%', '60%', '90%', '45%'] as const;

const IconButton = ({
  icon: Icon,
  label
}: {
  icon: LucideIcon;
  label: string;
}) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    className="flex h-6 w-6 items-center justify-center rounded border border-surface-panel bg-ink-inverse text-ink-muted shadow-sm hover:bg-surface-canvas hover:text-ink-default"
  >
    <Icon className="h-3.5 w-3.5" />
  </button>
);

const HtmlPreviewSurface = ({ state }: { state: HtmlPreviewState }) => (
  <div className="h-screen overflow-auto bg-surface-canvas-bg px-8 py-10">
    <div className="mx-auto w-full max-w-canvas-content">
      <div className="mx-auto w-full max-w-canvas-prose">
        <div className="group/decorator relative my-4">
          <div className="relative overflow-hidden rounded-lg border border-border-subtle bg-ink-inverse shadow-sm">
            <div className="absolute inset-x-0 top-0 z-20 flex h-10 items-center justify-end bg-ink-inverse/85 px-canvas-surface-pad backdrop-blur-sm">
              <div className="flex items-center gap-1">
                <IconButton icon={Pencil} label="Edit HTML" />
                <IconButton icon={Maximize2} label="Fullscreen" />
              </div>
            </div>
            <div
              data-moss-html-preview-viewport="true"
              className="relative h-full overflow-hidden bg-ink-inverse"
              style={{ height: 472 }}
            >
              <div className="moss-html-preview-scroll absolute inset-0 overflow-auto bg-ink-inverse">
                {state === 'loading' ? (
                  <div
                    data-testid="html-preview-loading"
                    className="absolute inset-x-0 bottom-0 top-10 bg-ink-inverse"
                  >
                    <div className="flex h-full flex-col gap-2 px-6 pb-8 pt-4">
                      {[...skeletonWidths, ...skeletonWidths].map((width, index) => (
                        <div
                          key={`${width}-${index}`}
                          data-testid="html-preview-loading-bar"
                          className="agent-skeleton-line agent-skeleton-line--empty"
                          style={{ width }}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}

                {state === 'error' ? (
                  <div
                    data-testid="html-preview-error"
                    className="absolute inset-0 z-20 flex items-center justify-center bg-surface-canvas px-6 py-8"
                  >
                    <div className="flex flex-col items-center gap-3 text-center">
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-ink-default">Preview unavailable</p>
                        <p className="text-xs text-ink-muted">
                          The HTML preview could not be generated right now.
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-label="Retry preview"
                        className="inline-flex h-8 items-center gap-2 rounded-full border border-surface-glass-border bg-ink-inverse px-3 text-xs font-medium text-ink-default transition-colors hover:bg-surface-canvas"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Retry
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="pointer-events-none absolute bottom-2 left-2 z-10">
                <span className="pointer-events-auto inline-flex cursor-pointer items-center gap-1 rounded border border-highlight-chalk-grey bg-highlight-chalk-grey-light px-1.5 py-0.5 text-[10px] font-medium text-ink-muted shadow-sm">
                  <TvMinimalPlay className="h-3 w-3" />
                  Live
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
);

const ReviewSurface = ({ children }: { children: React.ReactNode }) => (
  <div className="min-h-screen overflow-auto bg-surface-canvas-bg px-8 py-10">
    <div className="mx-auto w-full max-w-canvas-content">
      <div className="mx-auto w-full max-w-canvas-prose">
        {children}
      </div>
    </div>
  </div>
);

const quoteLinkClassName =
  'font-medium text-ink-accent underline decoration-border-default underline-offset-2 transition-colors hover:text-accent-brand hover:decoration-accent-brand';

const RawBlockquotePreview = ({
  paragraphs,
  attribution,
  links
}: {
  paragraphs: string[];
  attribution?: string;
  links?: Array<{ href: string; text: string }>;
}) => (
  <div className="group/decorator relative my-4">
    <div className="relative rounded-lg border border-border-subtle bg-ink-inverse px-5 py-4 shadow-sm">
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover/decorator:opacity-100 group-focus-within/decorator:opacity-100">
        <IconButton icon={Pencil} label="Edit HTML" />
        <IconButton icon={Trash2} label="Delete HTML block" />
      </div>
      <blockquote className="border-l-2 border-border-default pl-4 pr-10">
        <div className="space-y-3 text-base leading-relaxed text-ink-default">
          {paragraphs.map((paragraph) => (
            <p key={paragraph} className="whitespace-pre-wrap break-words">
              {paragraph}
            </p>
          ))}
        </div>
        {(attribution || links?.length) ? (
          <footer className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm leading-relaxed text-ink-muted">
            {attribution ? <span>{attribution}</span> : null}
            {links?.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className={quoteLinkClassName}
              >
                {link.text}
              </a>
            ))}
          </footer>
        ) : null}
      </blockquote>
    </div>
  </div>
);

export const LoadingSkeleton: Story = () => (
  <HtmlPreviewSurface state="loading" />
);
LoadingSkeleton.storyName = 'Loading Skeleton';

export const PreviewUnavailable: Story = () => (
  <HtmlPreviewSurface state="error" />
);
PreviewUnavailable.storyName = 'Preview Unavailable';

export const RawBlockquoteStyle: Story = () => (
  <ReviewSurface>
    <RawBlockquotePreview
      paragraphs={[
        'Rendered HTML embeds should preserve their block layout in PDF export.'
      ]}
      links={[
        {
          href: 'https://x.com/test/status/1',
          text: 'February 1, 2026'
        }
      ]}
    />
  </ReviewSurface>
);
RawBlockquoteStyle.storyName = 'Raw Blockquote Style';

export const TwitterBlockquoteStyle: Story = () => (
  <ReviewSurface>
    <RawBlockquotePreview
      paragraphs={[
        'I imagine the next breakout coding product is something that sticks a single orchestrator you talk with in front of cloud, parallel agents.',
        'It is too mentally taxing to keep a high number of parallel agents in the air by yourself. Plus brutal merge conflicts.'
      ]}
      attribution="Vincent van der Meulen (@vincentmvdm)"
      links={[
        {
          href: 'https://twitter.com/vincentmvdm/status/2027027874134343717',
          text: 'February 26, 2026'
        }
      ]}
    />
  </ReviewSurface>
);
TwitterBlockquoteStyle.storyName = 'Twitter Blockquote Style';
