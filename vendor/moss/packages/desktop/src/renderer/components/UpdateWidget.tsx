// ported-from: packages/desktop/src/renderer/components/UpdateWidget.tsx @ 762abb777
import { Newspaper, X } from 'lucide-react';
import type { UpdateReadyInfo } from '../../types/electron-api';

const stripMarkdown = (text: string): string =>
  text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

type UpdateWidgetProps = {
  info: UpdateReadyInfo;
  onDismiss: () => void;
};

export function UpdateWidget({ info, onDismiss }: UpdateWidgetProps) {
  return (
    <div className="fixed bottom-6 left-6 z-50 w-64 animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
      <div className="rounded-2xl border border-surface-glass-border bg-surface-glass px-5 py-4 shadow-lg backdrop-blur-2xl">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-xs font-medium leading-snug text-ink-default">
            <Newspaper className="h-3 w-3 shrink-0 text-accent-brand" strokeWidth={1.5} />
            Moss {info.version}
          </h3>
          <button
            type="button"
            onClick={onDismiss}
            className="-mr-0.5 -mt-0.5 shrink-0 self-start rounded p-1 text-ink-faint transition-colors hover:text-ink-default"
            aria-label="Dismiss"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">
          {stripMarkdown(info.highlights)}
        </p>
        <div className="mt-3 flex items-center gap-3">
          {info.canInstall && (
            <button
              type="button"
              onClick={() => window.electronAPI.update.install()}
              className="inline-flex items-center whitespace-nowrap rounded-md bg-accent-brand px-2.5 py-1.5 text-[11px] font-medium leading-none text-ink-on-accent transition-colors hover:bg-accent-brand-pressed"
            >
              Restart to update
            </button>
          )}
          {info.changelogUrl && (
            <a
              href={info.changelogUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-accent-brand-pressed transition-colors hover:text-accent-brand"
            >
              What&apos;s new
              <span className="inline-block transition-transform group-hover:translate-x-0.5">&rarr;</span>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
