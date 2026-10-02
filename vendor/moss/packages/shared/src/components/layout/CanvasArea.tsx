// ported-from: packages/shared/src/components/layout/CanvasArea.tsx @ 762abb777
import type { ReactNode, RefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

export interface CanvasAreaProps {
  className?: string;
  header?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  fullWidth?: boolean;
  contentClassName?: string;
  innerClassName?: string;
  responsiveLayout?: boolean;
  /** Expand content column width for focus/zen mode */
  wideContent?: boolean;
  floatingContent?: ReactNode;
  floatingContentClassName?: string;
  style?: React.CSSProperties;
  /** Optional ref to access the scroll container for ResizeObserver integration */
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
}

export function CanvasArea({
  className,
  header,
  footer,
  children,
  fullWidth = false,
  contentClassName,
  innerClassName,
  responsiveLayout = false,
  wideContent: _wideContent = false,
  floatingContent,
  floatingContentClassName,
  style,
  scrollContainerRef,
}: CanvasAreaProps) {
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleScroll = useCallback(() => {
    setIsScrolling(true);
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }
    scrollTimeoutRef.current = setTimeout(() => {
      setIsScrolling(false);
    }, 400);
  }, []);

  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  // Match sidebar folder text offset: px-4 (16) + row px-2 (8) + icon w-4 (16) + gap-1 (4) = 44px
  const responsiveClasses = [
    'px-canvas-gutter'
  ];

  return (
    <section
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col bg-surface-canvas',
        className
      )}
      style={style}
    >
      {header ? <div className="border-b border-border-subtle bg-surface-linen px-canvas-bar-inset pb-4 pt-6">{header}</div> : null}
      <div
        ref={scrollContainerRef}
        className={cn(
          'relative flex-1 overflow-y-auto overflow-x-hidden min-h-0 scroll-pb-24',
          'canvas-scroll',
          '@container/canvas'
        )}
        data-scrolling={isScrolling ? 'true' : 'false'}
        onScroll={handleScroll}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {fullWidth ? (
          <div className={cn('h-full w-full pb-16', innerClassName)} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>{children}</div>
        ) : (
          <>
            {/* Floating content - direct child of scroll container for proper sticky behavior */}
            {floatingContent ? (
              <div
                className={cn(
                  'pointer-events-none sticky top-6 z-30 w-full',
                  responsiveLayout ? ['mx-auto', 'max-w-canvas-readable', ...responsiveClasses] : ['max-w-canvas-content', 'px-canvas-bar-inset'],
                )}
              >
                <div className={cn(responsiveLayout && innerClassName, floatingContentClassName)}>
                  {floatingContent}
                </div>
              </div>
            ) : null}
            {/* Main content */}
            <div
              className={cn(
                'w-full',
                responsiveLayout
                  ? [...responsiveClasses, 'pb-24', 'pt-canvas-body-top']
                  : ['max-w-canvas-content', 'px-canvas-bar-inset', 'pb-16', 'pt-4'],
                contentClassName
              )}
            >
              <div
                className={cn('space-y-6', innerClassName)}
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              >
                {children}
              </div>
            </div>
          </>
        )}
      </div>
      {footer ? <div className="border-t border-border-subtle bg-surface-linen px-canvas-bar-inset py-4">{footer}</div> : null}
    </section>
  );
}

export default CanvasArea;
