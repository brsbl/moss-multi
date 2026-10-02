// ported-from: packages/shared/src/components/primitives/popover.tsx @ 762abb777
import * as React from 'react';
import { Popover as BasePopover } from '@base-ui/react/popover';

type VirtualAnchor = {
  getBoundingClientRect: () => DOMRect;
};

type PreventableNativeEvent = Event & {
  preventDefault: () => void;
};

interface PopoverCompatHandlers {
  onPointerDownOutside?: (event: PreventableNativeEvent) => void;
  onFocusOutside?: (event: PreventableNativeEvent) => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
}

interface PopoverCompatContextValue {
  anchorRef: React.MutableRefObject<React.RefObject<VirtualAnchor | null> | null>;
  setAnchorRef: (anchorRef: React.RefObject<VirtualAnchor | null> | null) => void;
  handlersRef: React.MutableRefObject<PopoverCompatHandlers>;
}

const PopoverCompatContext = React.createContext<PopoverCompatContextValue | null>(null);

type PopoverRootProps = Omit<BasePopover.Root.Props, 'onOpenChange'> & {
  onOpenChange?: (open: boolean) => void;
};

function callPreventableHandler(
  handler: ((event: PreventableNativeEvent) => void) | undefined,
  event: Event
) {
  if (!handler) return false;
  handler(event as PreventableNativeEvent);
  return event.defaultPrevented;
}

function PopoverRoot({ onOpenChange, children, ...props }: PopoverRootProps) {
  const anchorRef = React.useRef<React.RefObject<VirtualAnchor | null> | null>(null);
  const handlersRef = React.useRef<PopoverCompatHandlers>({});
  const [, forceAnchorRender] = React.useReducer((version: number) => version + 1, 0);
  const setAnchorRef = React.useCallback((nextAnchorRef: React.RefObject<VirtualAnchor | null> | null) => {
    if (anchorRef.current === nextAnchorRef) return;
    anchorRef.current = nextAnchorRef;
    forceAnchorRender();
  }, []);
  const context = React.useMemo(() => ({ anchorRef, setAnchorRef, handlersRef }), [setAnchorRef]);

  const handleOpenChange = React.useCallback(
    (nextOpen, eventDetails) => {
      if (!nextOpen) {
        const handlers = handlersRef.current;
        const reason = eventDetails.reason;

        if (
          reason === 'outside-press' &&
          callPreventableHandler(handlers.onPointerDownOutside, eventDetails.event)
        ) {
          eventDetails.cancel();
          return;
        }

        if (
          reason === 'focus-out' &&
          callPreventableHandler(handlers.onFocusOutside, eventDetails.event)
        ) {
          eventDetails.cancel();
          return;
        }

        if (reason === 'escape-key' && handlers.onEscapeKeyDown) {
          handlers.onEscapeKeyDown(eventDetails.event as KeyboardEvent);
          if (eventDetails.event.defaultPrevented) {
            eventDetails.cancel();
            return;
          }
        }
      }

      onOpenChange?.(nextOpen);
    },
    [onOpenChange]
  ) satisfies NonNullable<BasePopover.Root.Props['onOpenChange']>;

  return (
    <PopoverCompatContext.Provider value={context}>
      <BasePopover.Root onOpenChange={handleOpenChange} {...props}>
        {children}
      </BasePopover.Root>
    </PopoverCompatContext.Provider>
  );
}

type PopoverTriggerProps = React.ComponentPropsWithoutRef<typeof BasePopover.Trigger> & {
  asChild?: boolean;
};

const PopoverTrigger = React.forwardRef<HTMLElement, PopoverTriggerProps>(
  ({ asChild = false, children, render, ...props }, ref) => (
    <BasePopover.Trigger
      ref={ref as React.Ref<HTMLButtonElement>}
      render={render ?? (asChild ? React.Children.only(children) as React.ReactElement : undefined)}
      {...props}
    >
      {asChild ? undefined : children}
    </BasePopover.Trigger>
  )
);
PopoverTrigger.displayName = 'PopoverTrigger';

interface PopoverAnchorProps {
  virtualRef?: React.RefObject<VirtualAnchor | null>;
}

function PopoverAnchor({ virtualRef }: PopoverAnchorProps) {
  const context = React.useContext(PopoverCompatContext);

  React.useLayoutEffect(() => {
    if (!context) return;
    context.setAnchorRef(virtualRef ?? null);
    return () => {
      if (context.anchorRef.current === virtualRef) {
        context.setAnchorRef(null);
      }
    };
  }, [context, virtualRef]);

  return null;
}

type PopoverPositionerProps = Pick<
  BasePopover.Positioner.Props,
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

type PopoverContentProps = Omit<
  React.ComponentPropsWithoutRef<typeof BasePopover.Popup>,
  'className' | 'finalFocus' | 'initialFocus' | 'render'
> &
  PopoverPositionerProps & {
    avoidCollisions?: boolean;
    /** Granular collision override (e.g. `{ side: 'none' }` to pin the side but keep align shifting). Wins over avoidCollisions. */
    collisionAvoidance?: BasePopover.Positioner.Props['collisionAvoidance'];
    className?: string;
    positionerClassName?: string;
    onCloseAutoFocus?: (event: Event) => void;
    onEscapeKeyDown?: (event: KeyboardEvent) => void;
    onFocusOutside?: (event: PreventableNativeEvent) => void;
    onOpenAutoFocus?: (event: Event) => void;
    onPointerDownOutside?: (event: PreventableNativeEvent) => void;
  };

const disabledCollisionAvoidance: BasePopover.Positioner.Props['collisionAvoidance'] = {
  side: 'none',
  align: 'none',
  fallbackAxisSide: 'none',
};

function createAutoFocusEvent(type: string) {
  return new Event(type, { cancelable: true });
}

const PopoverContent = React.forwardRef<HTMLDivElement, PopoverContentProps>(
  (
    {
      align = 'center',
      alignOffset,
      arrowPadding,
      avoidCollisions = true,
      children,
      className,
      collisionAvoidance,
      collisionBoundary,
      collisionPadding,
      onCloseAutoFocus,
      onEscapeKeyDown,
      onFocusOutside,
      onOpenAutoFocus,
      onPointerDownOutside,
      positionMethod,
      positionerClassName = 'z-50',
      side = 'bottom',
      sideOffset = 0,
      sticky,
      ...props
    },
    ref
  ) => {
    const context = React.useContext(PopoverCompatContext);

    React.useEffect(() => {
      if (!context) return;
      context.handlersRef.current = {
        onEscapeKeyDown,
        onFocusOutside,
        onPointerDownOutside,
      };
      return () => {
        const current = context.handlersRef.current;
        if (
          current.onEscapeKeyDown === onEscapeKeyDown &&
          current.onFocusOutside === onFocusOutside &&
          current.onPointerDownOutside === onPointerDownOutside
        ) {
          context.handlersRef.current = {};
        }
      };
    }, [context, onEscapeKeyDown, onFocusOutside, onPointerDownOutside]);

    const initialFocus = React.useCallback(
      () => {
        if (!onOpenAutoFocus) return true;
        const event = createAutoFocusEvent('openAutoFocus');
        onOpenAutoFocus(event);
        return event.defaultPrevented ? false : true;
      },
      [onOpenAutoFocus]
    );

    const finalFocus = React.useCallback(
      () => {
        if (!onCloseAutoFocus) return true;
        const event = createAutoFocusEvent('closeAutoFocus');
        onCloseAutoFocus(event);
        return event.defaultPrevented ? false : true;
      },
      [onCloseAutoFocus]
    );

    return (
      <BasePopover.Positioner
        anchor={context?.anchorRef.current ? () => context.anchorRef.current?.current ?? null : undefined}
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        arrowPadding={arrowPadding}
        collisionBoundary={collisionBoundary}
        collisionPadding={collisionPadding}
        collisionAvoidance={collisionAvoidance ?? (avoidCollisions ? undefined : disabledCollisionAvoidance)}
        positionMethod={positionMethod}
        sticky={sticky}
        className={positionerClassName}
      >
        <BasePopover.Popup
          ref={ref}
          className={className}
          initialFocus={onOpenAutoFocus ? initialFocus : undefined}
          finalFocus={onCloseAutoFocus ? finalFocus : undefined}
          render={(renderProps, state) => (
            <div
              {...renderProps}
              data-radix-popper-content-wrapper=""
              data-state={state.open ? 'open' : 'closed'}
              data-side={state.side}
              data-align={state.align}
            />
          )}
          {...props}
        >
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    );
  }
);
PopoverContent.displayName = 'PopoverContent';

const PopoverPortal = BasePopover.Portal;
const PopoverClose = BasePopover.Close;
const PopoverArrow = BasePopover.Arrow;
const PopoverTitle = BasePopover.Title;
const PopoverDescription = BasePopover.Description;

const Popover = {
  Root: PopoverRoot,
  Trigger: PopoverTrigger,
  Anchor: PopoverAnchor,
  Portal: PopoverPortal,
  Content: PopoverContent,
  Close: PopoverClose,
  Arrow: PopoverArrow,
  Title: PopoverTitle,
  Description: PopoverDescription,
};

export {
  Popover,
  PopoverAnchor,
  PopoverArrow,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverPortal,
  PopoverRoot,
  PopoverTitle,
  PopoverTrigger,
};
