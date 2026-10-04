// ported-from: packages/shared/src/components/ui/draggable-modal.tsx @ 762abb777
import { useCallback, useEffect, useLayoutEffect, useRef, useState, createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface DraggableModalProps {
  children: ReactNode;
  className?: string;
  /** Called when drag starts on the header */
  onDragStart?: () => void;
  /** Called when drag ends */
  onDragEnd?: () => void;
}

/** Calculate the center position for the modal within the canvas area */
function calculateInitialPosition(modalWidth: number, modalHeight: number): { x: number; y: number } {
  // Handle SSR or environments without window/document
  if (typeof window === 'undefined') {
    return { x: 0, y: 0 };
  }

  const mainElement = document.querySelector('main');
  const canvasRect = mainElement?.getBoundingClientRect();

  // Center within the canvas area if found, otherwise fall back to window
  const canvasLeft = canvasRect?.left ?? 0;
  const canvasWidth = canvasRect?.width ?? window.innerWidth;
  const centerX = canvasLeft + (canvasWidth - modalWidth) / 2;

  return {
    x: centerX,
    y: window.innerHeight - modalHeight - 32 // 32px from bottom
  };
}

export function DraggableModal({
  children,
  className,
  onDragStart,
  onDragEnd
}: DraggableModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  // Use lazy initial state with estimates for SSR safety and initial render
  const [position, setPosition] = useState<{ x: number; y: number }>(() =>
    calculateInitialPosition(400, 300) // Initial estimates; measured after render
  );
  const [isDragging, setIsDragging] = useState(false);

  // Measure actual modal dimensions and reposition after first render
  useLayoutEffect(() => {
    const modal = modalRef.current;
    if (modal) {
      const rect = modal.getBoundingClientRect();
      setPosition(calculateInitialPosition(rect.width, rect.height));
    }
  }, []);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    setIsDragging(true);
    onDragStart?.();
    const modal = modalRef.current;
    if (modal) {
      const rect = modal.getBoundingClientRect();
      setDragOffset({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      });
    }
  }, [onDragStart]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newX = e.clientX - dragOffset.x;
      const newY = e.clientY - dragOffset.y;

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
      onDragEnd?.();
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragOffset, onDragEnd]);

  return (
    <DraggableModalContext.Provider value={{ onMouseDown: handleMouseDown }}>
      <div
        ref={modalRef}
        className={cn(
          'fixed z-50 overflow-hidden rounded-2xl border border-border-subtle bg-surface-floating shadow-2xl',
          className
        )}
        style={{
          left: `${position.x}px`,
          top: `${position.y}px`,
          cursor: isDragging ? 'grabbing' : 'auto',
          WebkitAppRegion: 'no-drag'
        } as React.CSSProperties}
      >
        {children}
      </div>
    </DraggableModalContext.Provider>
  );
}

// Context to pass handleMouseDown to DraggableModalHeader
interface DraggableModalContextValue {
  onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
}

const DraggableModalContext = createContext<DraggableModalContextValue | null>(null);

export function useDraggableModal() {
  const context = useContext(DraggableModalContext);
  if (!context) {
    throw new Error('useDraggableModal must be used within a DraggableModal');
  }
  return context;
}

export default DraggableModal;

// --- DraggableModalHeader ---

export interface DraggableModalHeaderProps {
  onClose: () => void;
  /** Optional: pass onMouseDown directly if not using DraggableModal wrapper */
  onMouseDown?: (e: React.MouseEvent<HTMLDivElement>) => void;
  leftContent?: ReactNode;
  /** Optional content to render before the close button */
  rightContent?: ReactNode;
  className?: string;
}

export function DraggableModalHeader({
  onClose,
  onMouseDown: onMouseDownProp,
  leftContent,
  rightContent,
  className
}: DraggableModalHeaderProps) {
  // Try to get onMouseDown from context, fall back to prop
  let contextOnMouseDown: ((e: React.MouseEvent<HTMLDivElement>) => void) | undefined;
  try {
    const context = useDraggableModal();
    contextOnMouseDown = context.onMouseDown;
  } catch {
    // Not inside DraggableModal, use prop
  }

  const onMouseDown = onMouseDownProp ?? contextOnMouseDown;

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    // Don't start drag if clicking on a button
    if ((e.target as HTMLElement).closest('button')) {
      return;
    }
    onMouseDown?.(e);
  };

  return (
    <div
      className={cn(
        'flex flex-shrink-0 items-center rounded-t-2xl border-b border-border-subtle bg-surface-linen px-5 py-3 shadow-sm cursor-grab active:cursor-grabbing',
        className
      )}
      onMouseDown={handleMouseDown}
    >
      {leftContent}
      <div className="ml-auto flex items-center gap-2">
        {rightContent}
        <button
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded-full text-ink-faint/60 transition-colors hover:bg-border-subtle hover:text-ink-muted"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
