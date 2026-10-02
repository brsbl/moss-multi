// ported-from: packages/shared/src/components/ui/prompt-box.tsx @ 762abb777
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AtSign, Loader2, X, Command, CornerDownLeft } from 'lucide-react';

interface PromptBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClose?: () => void;
  onCancel?: () => void;
  isSubmitting?: boolean;
}

// Expected modal dimensions for initial center calculation
// These match the max-w-timeline-width constraint and typical content height
const MODAL_WIDTH = 640;
const MODAL_HEIGHT = 200;
const BOTTOM_OFFSET = 32; // 8 * 4px = bottom-8

function calculateInitialPosition(): { x: number; y: number } {
  // Handle SSR or environments without window
  if (typeof window === 'undefined') {
    return { x: 0, y: 0 };
  }

  // Center within the canvas area (main element), not the entire window
  const mainElement = document.querySelector('main');
  const canvasRect = mainElement?.getBoundingClientRect();
  const canvasLeft = canvasRect?.left ?? 0;
  const canvasWidth = canvasRect?.width ?? window.innerWidth;

  return {
    x: canvasLeft + (canvasWidth - MODAL_WIDTH) / 2,
    y: window.innerHeight - MODAL_HEIGHT - BOTTOM_OFFSET
  };
}

export function PromptBox({
  value,
  onChange,
  onSubmit,
  onClose,
  onCancel,
  isSubmitting = false
}: PromptBoxProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(calculateInitialPosition);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  // Recalculate position after mount when DOM is ready
  useLayoutEffect(() => {
    setPosition(calculateInitialPosition());
  }, []);

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    // Only start drag on the header background, not on buttons
    if ((e.target as HTMLElement).closest('button')) {
      return;
    }

    setIsDragging(true);
    const modal = modalRef.current;
    if (modal) {
      const rect = modal.getBoundingClientRect();
      setDragOffset({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      });
    }
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newX = e.clientX - dragOffset.x;
      const newY = e.clientY - dragOffset.y;

      // Keep modal within viewport bounds
      const modal = modalRef.current;
      if (modal) {
        const rect = modal.getBoundingClientRect();
        const maxX = window.innerWidth - rect.width;
        const maxY = window.innerHeight - rect.height;

        setPosition({
          x: Math.max(0, Math.min(newX, maxX)),
          y: Math.max(0, Math.min(newY, maxY))
        });
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragOffset]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
      return;
    }

    const isModifierEnter = (e.metaKey || e.ctrlKey) && e.key === 'Enter';

    if (isModifierEnter && value.trim() && !isSubmitting) {
      e.preventDefault();
      onSubmit();
    }
  };

  const isDisabled = !value.trim() || isSubmitting;
  const handleCancel = () => {
    if (onCancel) {
      onCancel();
    } else {
      onClose?.();
    }
  };

  return (
    <div
      ref={modalRef}
      className="fixed z-50 w-full max-w-timeline-max sm:max-w-timeline-width overflow-hidden rounded-2xl border border-border-subtle bg-surface-floating shadow-2xl"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        cursor: isDragging ? 'grabbing' : 'auto'
      }}
    >
      {/* Header */}
      <div
        className="flex flex-shrink-0 items-center justify-end gap-2 border-b border-border-subtle bg-surface-linen px-5 py-3 shadow-sm cursor-grab active:cursor-grabbing"
        onMouseDown={handleMouseDown}
      >
        <button
          onClick={handleCancel}
          className="flex h-6 w-6 items-center justify-center rounded-full text-ink-faint/60 transition-colors hover:bg-border-subtle hover:text-ink-muted"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>

      <div className="bg-surface-canvas p-6">

        {/* Textarea */}
        <textarea
          autoFocus
          placeholder="Try asking to analyze data, do research, summarize content, or organize your thoughts..."
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          className="w-full resize-none rounded-lg border border-surface-note-hover bg-surface-raised-control px-4 py-3 text-small text-ink-default outline-none placeholder:text-ink-subtle focus-visible:ring-1 focus-visible:ring-accent-success-ring"
        />

        {/* Footer */}
        <div className="mt-4 flex items-center justify-between font-mono text-code">
          {/* Left side: keyboard shortcuts hints */}
          <div className="flex items-center gap-3 text-caption text-ink-muted">
            <div className="flex items-center gap-1.5">
              <div className="flex items-center gap-0.5 rounded border border-surface-note-hover bg-surface-raised-control px-1.5 py-0.5">
                <span className="text-micro">⌥</span>
                <span className="text-micro">O</span>
              </div>
              <span>Open file picker</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="flex items-center justify-center rounded border border-surface-note-hover bg-surface-raised-control px-1.5 py-0.5">
                <AtSign className="h-3 w-3" aria-hidden />
              </div>
              <span>Reference files or folders</span>
            </div>
          </div>

          {/* Right side: Cancel and Submit buttons */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCancel}
              className="flex items-center gap-1 rounded-md px-3 py-2 text-caption text-ink-subtle transition-colors hover:bg-surface-note-hover hover:text-ink-default"
            >
              <div className="rounded border border-surface-note-hover bg-surface-raised-control px-1.5 py-0.5">
                <span className="text-micro">ESC</span>
              </div>
              <span>Cancel</span>
            </button>
            <button
              type="button"
              onClick={onSubmit}
              disabled={isDisabled}
              className="flex items-center gap-2 rounded-md bg-accent-brand px-4 py-2 text-caption text-ink-on-accent transition-colors hover:bg-accent-brand-pressed disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <div className="flex items-center gap-0.5">
                  <div className="flex items-center justify-center rounded bg-surface-raised-card/40 px-1 py-0.5">
                    <Command className="h-3 w-3" />
                  </div>
                  <div className="flex items-center justify-center rounded bg-surface-raised-card/40 px-1 py-0.5">
                    <CornerDownLeft className="h-3 w-3" />
                  </div>
                </div>
              )}
              <span>{isSubmitting ? 'Submitting' : 'Submit'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default PromptBox;
