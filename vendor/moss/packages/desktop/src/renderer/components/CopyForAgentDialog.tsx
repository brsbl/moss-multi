// ported-from: packages/desktop/src/renderer/components/CopyForAgentDialog.tsx @ 762abb777
import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { Copy, Check } from 'lucide-react';
import { ModalShell } from './ModalShell';

interface CopyForAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  message: string;
}

const pathLabelPattern = /^(I'm working in|Edit the note at): (.+)$/;

/** Render inline `code` spans within a text string. */
function renderInlineCode(text: string, keyPrefix: string): React.ReactNode[] {
  const parts = text.split(/(`[^`]+`)/);
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={`${keyPrefix}-${i}`} className="rounded bg-surface-code px-1 py-0.5 font-mono text-[0.875em] text-ink-default">{part.slice(1, -1)}</code>;
    }
    return <span key={`${keyPrefix}-${i}`}>{part}</span>;
  });
}

function renderContent(text: string) {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let key = 0;

  // Group lines into sections split by `---`
  const sections: string[][] = [[]];
  for (const line of lines) {
    if (line.trim() === '---') {
      sections.push([]);
    } else {
      sections[sections.length - 1].push(line);
    }
  }

  for (let sectionIdx = 0; sectionIdx < sections.length; sectionIdx++) {
    const sectionLines = sections[sectionIdx];
    const sectionElements: React.ReactNode[] = [];

    for (const line of sectionLines) {
      if (line.startsWith('## ')) {
        sectionElements.push(
          <span key={key++} className="text-micro font-medium uppercase tracking-wider text-ink-faint">{line.slice(3)}</span>,
        );
      } else if (pathLabelPattern.test(line)) {
        const match = line.match(pathLabelPattern)!;
        sectionElements.push(
          <div key={key++} className="space-y-2">
            <span className="text-micro font-medium uppercase tracking-wider text-ink-faint">{match[1]}</span>
            <div className="rounded-lg border border-border-subtle bg-surface-raised-card px-3 py-2.5">
              <p className="break-all font-mono text-xs leading-relaxed text-ink-default">{match[2]}</p>
            </div>
          </div>,
        );
      } else if (line.startsWith('> ')) {
        sectionElements.push(
          <div key={key++} className="rounded-lg border border-border-subtle bg-surface-raised-card px-3 py-2.5">
            <p className="break-all font-mono text-xs leading-relaxed text-ink-muted">{line.slice(2)}</p>
          </div>,
        );
      } else if (line.trim() === '') {
        // skip
      } else if (line.startsWith('! ')) {
        sectionElements.push(
          <p key={key++} className="text-xs leading-relaxed text-ink-default">{renderInlineCode(line.slice(2), `p${key}`)}</p>,
        );
      } else {
        sectionElements.push(
          <p key={key++} className="text-xs leading-relaxed text-ink-muted">{renderInlineCode(line, `p${key}`)}</p>,
        );
      }
    }

    if (sectionElements.length > 0) {
      elements.push(
        <div key={`s${sectionIdx}`} className="space-y-2">
          {sectionElements}
        </div>,
      );
    }
  }

  return elements;
}

export function CopyForAgentDialog({
  open,
  onOpenChange,
  message
}: CopyForAgentDialogProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopyPrompt = useCallback(() => {
    void navigator.clipboard.writeText(message);
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 2000);
  }, [message]);

  const rendered = useMemo(() => renderContent(message || ''), [message]);

  const footer = (
    <div className="flex shrink-0 justify-end px-6 pb-4 pt-0">
      <button
        type="button"
        onClick={handleCopyPrompt}
        className="flex items-center gap-1.5 rounded-md bg-accent-brand px-2.5 py-1.5 text-micro text-ink-on-accent transition-colors hover:bg-accent-brand-pressed"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? 'Prompt copied' : 'Copy prompt'}
      </button>
    </div>
  );

  return (
    <ModalShell
      open={open}
      onOpenChange={onOpenChange}
      title="Share with Agent"
      description="Copy a prompt to share with your agent."
      footer={footer}
    >
      <div className="space-y-4 rounded-lg border border-border-subtle bg-surface-raised-card p-4">
        {rendered}
      </div>
    </ModalShell>
  );
}
