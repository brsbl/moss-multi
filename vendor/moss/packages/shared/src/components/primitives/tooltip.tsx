// ported-from: packages/shared/src/components/primitives/tooltip.tsx @ 762abb777
import * as React from 'react';
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';

import { cn } from '@/lib/utils';

type TooltipProviderProps = Omit<BaseTooltip.Provider.Props, 'delay' | 'timeout'> & {
  delayDuration?: number;
  skipDelayDuration?: number;
};

function TooltipProvider({
  delayDuration,
  skipDelayDuration,
  ...props
}: TooltipProviderProps) {
  return (
    <BaseTooltip.Provider
      delay={delayDuration}
      timeout={skipDelayDuration}
      {...props}
    />
  );
}

type TooltipProps = Omit<BaseTooltip.Root.Props, 'disableHoverablePopup'> & {
  disableHoverableContent?: boolean;
};

type TooltipBoundaryContextValue = {
  triggerElement: HTMLElement | null;
  setTriggerElement: React.Dispatch<React.SetStateAction<HTMLElement | null>>;
};

const TooltipBoundaryContext = React.createContext<TooltipBoundaryContextValue | null>(null);
const TooltipCollisionBoundaryContext = React.createContext<React.RefObject<Element | null> | null>(
  null
);

type TooltipCollisionBoundaryProviderProps = {
  boundaryRef: React.RefObject<Element | null>;
  children: React.ReactNode;
};

function TooltipCollisionBoundaryProvider({
  boundaryRef,
  children
}: TooltipCollisionBoundaryProviderProps) {
  return (
    <TooltipCollisionBoundaryContext.Provider value={boundaryRef}>
      {children}
    </TooltipCollisionBoundaryContext.Provider>
  );
}

function Tooltip({ disableHoverableContent, ...props }: TooltipProps) {
  const [triggerElement, setTriggerElement] = React.useState<HTMLElement | null>(null);
  const boundaryContext = React.useMemo(
    () => ({ triggerElement, setTriggerElement }),
    [triggerElement]
  );

  return (
    <TooltipBoundaryContext.Provider value={boundaryContext}>
      <BaseTooltip.Root disableHoverablePopup={disableHoverableContent} {...props} />
    </TooltipBoundaryContext.Provider>
  );
}

type TooltipTriggerProps = React.ComponentPropsWithoutRef<typeof BaseTooltip.Trigger> & {
  asChild?: boolean;
};

const TooltipTrigger = React.forwardRef<HTMLElement, TooltipTriggerProps>(
  ({ asChild = false, children, render, ...props }, ref) => {
    const boundaryContext = React.useContext(TooltipBoundaryContext);
    const setBoundaryTriggerElement = boundaryContext?.setTriggerElement;
    const setTriggerRef = React.useCallback(
      (element: HTMLElement | null) => {
        setBoundaryTriggerElement?.(element);
        if (typeof ref === 'function') {
          ref(element);
        } else if (ref) {
          ref.current = element;
        }
      },
      [ref, setBoundaryTriggerElement]
    );

    return (
      <BaseTooltip.Trigger
        ref={setTriggerRef as React.Ref<HTMLButtonElement>}
        render={render ?? (asChild ? React.Children.only(children) as React.ReactElement : undefined)}
        {...props}
      >
        {asChild ? undefined : children}
      </BaseTooltip.Trigger>
    );
  }
);
TooltipTrigger.displayName = 'TooltipTrigger';

type TooltipPositionerProps = Pick<
  BaseTooltip.Positioner.Props,
  | 'align'
  | 'alignOffset'
  | 'arrowPadding'
  | 'collisionBoundary'
  | 'collisionPadding'
  | 'positionMethod'
  | 'side'
  | 'sideOffset'
  | 'sticky'
>;

type TooltipContentProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseTooltip.Popup>,
  'className' | 'render'
> &
  TooltipPositionerProps & {
    className?: string;
    avoidCollisions?: boolean;
  };

const disabledCollisionAvoidance: BaseTooltip.Positioner.Props['collisionAvoidance'] = {
  side: 'none',
  align: 'none',
  fallbackAxisSide: 'none',
};

const TOOLTIP_LAYER_Z_INDEX = 170;

export function resolveTooltipCollisionBoundary(
  triggerElement: HTMLElement | null,
  explicitBoundary: TooltipPositionerProps['collisionBoundary'],
  contextualBoundary?: Element | null
): TooltipPositionerProps['collisionBoundary'] {
  if (explicitBoundary !== undefined) {
    return explicitBoundary;
  }
  return (
    contextualBoundary ??
    triggerElement?.closest('[data-tooltip-collision-boundary="true"]') ??
    undefined
  );
}

const TooltipContent = React.forwardRef<HTMLDivElement, TooltipContentProps>(
  (
    {
      className,
      side = 'top',
      align = 'center',
      sideOffset = 4,
      alignOffset,
      arrowPadding,
      collisionBoundary,
      collisionPadding,
      positionMethod,
      sticky,
      avoidCollisions = true,
      ...props
    },
    ref
  ) => {
    const boundaryContext = React.useContext(TooltipBoundaryContext);
    const collisionBoundaryRef = React.useContext(TooltipCollisionBoundaryContext);
    const resolvedCollisionBoundary = resolveTooltipCollisionBoundary(
      boundaryContext?.triggerElement ?? null,
      collisionBoundary,
      collisionBoundaryRef?.current
    );

    return (
      <BaseTooltip.Portal
        // moss-multi seam: overlay-surface (A§19, the floating detector's allowlist)
        data-overlay-surface=""
      >
        <BaseTooltip.Positioner
          render={(renderProps) => (
            <div
              {...renderProps}
              className={cn(renderProps.className, 'z-tooltip')}
              style={{ ...renderProps.style, zIndex: TOOLTIP_LAYER_Z_INDEX }}
            />
          )}
          side={side}
          align={align}
          sideOffset={sideOffset}
          alignOffset={alignOffset}
          arrowPadding={arrowPadding}
          collisionBoundary={resolvedCollisionBoundary}
          collisionPadding={collisionPadding}
          collisionAvoidance={avoidCollisions ? undefined : disabledCollisionAvoidance}
          positionMethod={positionMethod}
          sticky={sticky}
        >
          <BaseTooltip.Popup
            ref={ref}
            role="tooltip"
            className={cn(
              'z-tooltip overflow-hidden rounded-md border border-border-subtle bg-surface-floating px-2.5 py-1 text-nano font-light text-ink-default shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
              className
            )}
            render={(renderProps, state) => (
              <div
                {...renderProps}
                data-state={state.open ? 'open' : 'closed'}
                data-side={state.side}
                data-align={state.align}
              />
            )}
            {...props}
          />
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    );
  }
);
TooltipContent.displayName = 'TooltipContent';

const TooltipPortal = BaseTooltip.Portal;
const TooltipArrow = BaseTooltip.Arrow;

export {
  Tooltip,
  TooltipArrow,
  TooltipCollisionBoundaryProvider,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
};
