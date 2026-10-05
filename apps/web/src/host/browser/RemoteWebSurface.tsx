// Substituted for moss's editor/preview/RemoteWebSurface.tsx in the web build (A§2.1, A§16; R4): moss positions a
// native Electron WebContentsView over this element, and the web frames the page in a sandboxed iframe instead,
// under moss's own `remote-webpage` policy (scripts and forms, never same-origin). Many sites refuse framing, which a
// cross-origin frame cannot detect, so "Open in new tab" is always offered.
import type { JSX } from 'react';
import { ExternalLink } from 'lucide-react';
import { getEmbedIframePolicy } from '@moss-desktop/common/embed-iframe-policy';
import { resolveRemoteWebSurfaceUrl } from '@moss-desktop/common/web-embed-url';

export interface RemoteWebSurfaceProps {
  id: string;
  noteId: string | null;
  nodeKey: string;
  mode: 'card' | 'fullscreen' | 'split';
  navigationRequestId?: number;
  url: string;
  title: string;
  active: boolean;
  commandPaletteShortcutEnabled?: boolean;
  className?: string;
  dataAttributes?: Record<string, string>;
  onError?: (errorCode: string) => void;
}

const POLICY = getEmbedIframePolicy('remote-webpage');

export function RemoteWebSurface({ navigationRequestId, url, title, active, className, dataAttributes }: RemoteWebSurfaceProps): JSX.Element {
  const src = resolveRemoteWebSurfaceUrl(url);
  return (
    <div className={className} {...dataAttributes}>
      {active ? (
        <iframe
          // A navigation request reloads the page, as moss reloads its native view.
          key={`${navigationRequestId ?? 0}:${src}`}
          src={src}
          title={title || src}
          sandbox={POLICY.sandbox}
          referrerPolicy={POLICY.referrerPolicy}
          className="absolute inset-0 h-full w-full border-0"
        />
      ) : null}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="absolute bottom-3 right-3 z-10 inline-flex items-center gap-2 rounded-full border border-border-subtle bg-surface-raised-card px-3 py-1.5 text-xs font-medium text-ink-default shadow-sm transition-colors hover:bg-surface-canvas"
      >
        <ExternalLink aria-hidden className="h-3.5 w-3.5" />
        Open in new tab
      </a>
    </div>
  );
}

export default RemoteWebSurface;
