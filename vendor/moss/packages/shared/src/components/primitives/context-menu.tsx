// ported-from: packages/shared/src/components/primitives/context-menu.tsx @ 762abb777
import * as React from 'react';
import { ContextMenu as BaseContextMenu } from '@base-ui/react/context-menu';
import { DirectionProvider } from '@base-ui/react/direction-provider';
import { mergeProps } from '@base-ui/react/merge-props';
import type { ComponentRenderFn, HTMLProps } from '@base-ui/react/types';

import { cn } from '@/lib/utils';

type CompatState = {
  align?: string;
  checked?: boolean;
  disabled?: boolean;
  highlighted?: boolean;
  open?: boolean;
  side?: string;
};

type CompatRender<State extends CompatState> =
  | React.ReactElement
  | ComponentRenderFn<HTMLProps, State>;

type StatefulClassName<State extends CompatState> =
  | string
  | ((state: State) => string | undefined);

type StatefulStyle<State extends CompatState> =
  | React.CSSProperties
  | ((state: State) => React.CSSProperties | undefined);

type PreventableNativeEvent = Event & {
  preventDefault: () => void;
};

type BaseUIPreventableSyntheticEvent = React.SyntheticEvent<HTMLElement> & {
  preventBaseUIHandler?: () => void;
};

interface ContextMenuCompatHandlers {
  onCloseAutoFocus?: (event: Event) => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onFocusOutside?: (event: PreventableNativeEvent) => void;
  onInteractOutside?: (event: PreventableNativeEvent) => void;
  onPointerDownOutside?: (event: PreventableNativeEvent) => void;
}

interface ContextMenuCompatContextValue {
  handlersRef: React.MutableRefObject<ContextMenuCompatHandlers>;
}

const ContextMenuCompatContext = React.createContext<ContextMenuCompatContextValue | null>(null);

const contextMenuContentClassName =
  'z-50 min-w-32 overflow-hidden rounded-lg border border-border-subtle bg-surface-floating p-1 text-ink-default shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2';

const contextMenuItemClassName =
  'relative flex w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-left text-micro outline-none transition-colors hover:bg-surface-panel hover:text-accent-brand-pressed focus:bg-surface-panel focus:text-accent-brand-pressed data-[highlighted]:bg-surface-panel data-[highlighted]:text-accent-brand-pressed data-[disabled]:pointer-events-none data-[disabled]:opacity-50';

const destructiveItemClassName =
  'text-status-error-text focus:text-status-error-text data-[highlighted]:text-status-error-text';

const disabledCollisionAvoidance: BaseContextMenu.Positioner.Props['collisionAvoidance'] = {
  side: 'none',
  align: 'none',
  fallbackAxisSide: 'none',
};

function getCompatStateProps(state: CompatState) {
  const dataState = typeof state.open === 'boolean'
    ? state.open ? 'open' : 'closed'
    : typeof state.checked === 'boolean'
      ? state.checked ? 'checked' : 'unchecked'
      : undefined;

  return {
    'data-state': dataState,
    'data-disabled': state.disabled ? '' : undefined,
    'data-highlighted': state.highlighted ? '' : undefined,
    'data-side': state.side,
    'data-align': state.align,
  };
}

function withBaseClassName<State extends CompatState>(
  baseClassName: string,
  className: StatefulClassName<State> | undefined
) {
  if (typeof className === 'function') {
    return (state: State) => cn(baseClassName, className(state));
  }

  return cn(baseClassName, className);
}

function withItemClassName<State extends CompatState>(
  className: StatefulClassName<State> | undefined,
  inset: boolean,
  destructive: boolean
) {
  return withBaseClassName(
    cn(contextMenuItemClassName, inset && 'pl-8', destructive && destructiveItemClassName),
    className
  );
}

function withNoDragStyle<State extends CompatState>(
  style: StatefulStyle<State> | undefined
) {
  if (typeof style === 'function') {
    return (state: State) => ({
      WebkitAppRegion: 'no-drag',
      ...(style(state) ?? {}),
    }) as React.CSSProperties;
  }

  return {
    WebkitAppRegion: 'no-drag',
    ...(style ?? {}),
  } as React.CSSProperties;
}

function isNativeButtonElement(children: React.ReactNode) {
  return React.isValidElement(children) && children.type === 'button';
}

function renderCompatElement<State extends CompatState>(
  tagName: 'div' | 'span',
  render: CompatRender<State> | undefined,
  asChild: boolean,
  children: React.ReactNode,
  renderProps: HTMLProps,
  state: State
) {
  const compatProps = getCompatStateProps(state);

  if (typeof render === 'function') {
    return render(mergeProps(renderProps, compatProps), state);
  }

  const child = asChild
    ? React.Children.only(children) as React.ReactElement<Record<string, unknown>>
    : undefined;
  const element = render ?? child;

  if (element) {
    const props = mergeProps(
      renderProps,
      compatProps,
      element.props as React.ComponentPropsWithRef<React.ElementType>
    );
    props.ref = renderProps.ref;
    return React.cloneElement(element, props);
  }

  return React.createElement(tagName, mergeProps(renderProps, compatProps));
}

function createAutoFocusEvent(type: string) {
  return new Event(type, { cancelable: true });
}

function callPreventableHandler(
  handler: ((event: PreventableNativeEvent) => void) | undefined,
  event: Event
) {
  if (!handler) return false;
  handler(event as PreventableNativeEvent);
  return event.defaultPrevented;
}

function preventBaseContextMenuHandler(event: BaseUIPreventableSyntheticEvent) {
  event.preventDefault();
  event.preventBaseUIHandler?.();
}

function callSelectHandler(
  onSelect: ((event: Event) => void) | undefined,
  event: BaseUIPreventableSyntheticEvent
) {
  if (!onSelect) return;
  const selectEvent = new Event('select', { cancelable: true });
  onSelect(selectEvent);
  if (selectEvent.defaultPrevented) {
    preventBaseContextMenuHandler(event);
  }
}

type ContextMenuRootProps = Omit<
  BaseContextMenu.Root.Props,
  'modal' | 'onOpenChange'
> & {
  dir?: 'ltr' | 'rtl';
  modal?: boolean;
  onOpenChange?: (open: boolean) => void;
};

function ContextMenuRoot({
  children,
  dir,
  modal: _modal,
  onOpenChange,
  ...props
}: ContextMenuRootProps) {
  const handlersRef = React.useRef<ContextMenuCompatHandlers>({});
  const context = React.useMemo(() => ({ handlersRef }), []);

  const handleOpenChange = React.useCallback(
    (open: boolean, eventDetails: BaseContextMenu.Root.ChangeEventDetails) => {
      if (!open) {
        const handlers = handlersRef.current;
        const reason = eventDetails.reason;
        const event = eventDetails.event;

        if (reason === 'outside-press') {
          const pointerPrevented = callPreventableHandler(
            handlers.onPointerDownOutside,
            event
          );
          const interactPrevented = callPreventableHandler(handlers.onInteractOutside, event);
          if (pointerPrevented || interactPrevented) {
            eventDetails.cancel();
            return;
          }
        }

        if (reason === 'focus-out') {
          const focusPrevented = callPreventableHandler(handlers.onFocusOutside, event);
          const interactPrevented = callPreventableHandler(handlers.onInteractOutside, event);
          if (focusPrevented || interactPrevented) {
            eventDetails.cancel();
            return;
          }
        }

        if (reason === 'escape-key' && handlers.onEscapeKeyDown) {
          handlers.onEscapeKeyDown(event as KeyboardEvent);
          if (event.defaultPrevented) {
            eventDetails.cancel();
            return;
          }
        }
      }

      onOpenChange?.(open);
    },
    [onOpenChange]
  ) satisfies NonNullable<BaseContextMenu.Root.Props['onOpenChange']>;

  return (
    <ContextMenuCompatContext.Provider value={context}>
      <DirectionProvider direction={dir}>
        <BaseContextMenu.Root onOpenChange={handleOpenChange} {...props}>
          {children}
        </BaseContextMenu.Root>
      </DirectionProvider>
    </ContextMenuCompatContext.Provider>
  );
}
ContextMenuRoot.displayName = 'ContextMenuRoot';

type ContextMenuTriggerProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseContextMenu.Trigger>,
  'render'
> & {
  asChild?: boolean;
  render?: CompatRender<BaseContextMenu.Trigger.State>;
};

const ContextMenuTrigger = React.forwardRef<HTMLElement, ContextMenuTriggerProps>(
  ({ asChild = false, children, render, ...props }, ref) => (
    <BaseContextMenu.Trigger
      ref={ref as React.Ref<HTMLDivElement>}
      render={(renderProps, state) =>
        renderCompatElement('div', render, asChild, children, renderProps, state)
      }
      {...props}
    >
      {asChild || render ? undefined : children}
    </BaseContextMenu.Trigger>
  )
);
ContextMenuTrigger.displayName = 'ContextMenuTrigger';

type ContextMenuPortalProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseContextMenu.Portal>,
  'keepMounted'
> & {
  forceMount?: boolean;
  keepMounted?: boolean;
};

const ContextMenuPortal = React.forwardRef<HTMLDivElement, ContextMenuPortalProps>(
  ({ forceMount, keepMounted, ...props }, ref) => (
    <BaseContextMenu.Portal
      ref={ref}
      keepMounted={keepMounted ?? forceMount}
      // moss-multi seam: overlay-surface (A§19, the floating detector's allowlist)
      data-overlay-surface=""
      {...props}
    />
  )
);
ContextMenuPortal.displayName = 'ContextMenuPortal';

type ContextMenuPositionerProps = Pick<
  BaseContextMenu.Positioner.Props,
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

type ContextMenuContentProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseContextMenu.Popup>,
  'className' | 'finalFocus' | 'render' | 'style'
> &
  ContextMenuPositionerProps & {
    asChild?: boolean;
    avoidCollisions?: boolean;
    className?: StatefulClassName<BaseContextMenu.Popup.State>;
    forceMount?: boolean;
    onCloseAutoFocus?: (event: Event) => void;
    onEscapeKeyDown?: (event: KeyboardEvent) => void;
    onFocusOutside?: (event: PreventableNativeEvent) => void;
    onInteractOutside?: (event: PreventableNativeEvent) => void;
    onOpenAutoFocus?: (event: Event) => void;
    onPointerDownOutside?: (event: PreventableNativeEvent) => void;
    render?: CompatRender<BaseContextMenu.Popup.State>;
    style?: StatefulStyle<BaseContextMenu.Popup.State>;
    updatePositionStrategy?: 'optimized' | 'always';
  };

const ContextMenuContent = React.forwardRef<HTMLDivElement, ContextMenuContentProps>(
  (
    {
      align = 'start',
      alignOffset,
      arrowPadding,
      asChild = false,
      avoidCollisions = true,
      children,
      className,
      collisionBoundary,
      collisionPadding = 8,
      forceMount,
      onCloseAutoFocus,
      onEscapeKeyDown,
      onFocusOutside,
      onInteractOutside,
      onOpenAutoFocus: _onOpenAutoFocus,
      onPointerDownOutside,
      positionMethod,
      render,
      side = 'bottom',
      sideOffset = 4,
      sticky,
      style,
      updatePositionStrategy,
      ...props
    },
    ref
  ) => {
    const context = React.useContext(ContextMenuCompatContext);

    React.useEffect(() => {
      if (!context) return;
      context.handlersRef.current = {
        onCloseAutoFocus,
        onEscapeKeyDown,
        onFocusOutside,
        onInteractOutside,
        onPointerDownOutside,
      };
      return () => {
        const current = context.handlersRef.current;
        if (
          current.onCloseAutoFocus === onCloseAutoFocus &&
          current.onEscapeKeyDown === onEscapeKeyDown &&
          current.onFocusOutside === onFocusOutside &&
          current.onInteractOutside === onInteractOutside &&
          current.onPointerDownOutside === onPointerDownOutside
        ) {
          context.handlersRef.current = {};
        }
      };
    }, [
      context,
      onCloseAutoFocus,
      onEscapeKeyDown,
      onFocusOutside,
      onInteractOutside,
      onPointerDownOutside,
    ]);

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
      <ContextMenuPortal forceMount={forceMount}>
        <BaseContextMenu.Positioner
          render={(renderProps) => (
            <div
              {...renderProps}
              className={cn(renderProps.className, 'z-50')}
            />
          )}
          side={side}
          align={align}
          sideOffset={sideOffset}
          alignOffset={alignOffset}
          arrowPadding={arrowPadding}
          collisionBoundary={collisionBoundary}
          collisionPadding={collisionPadding}
          collisionAvoidance={avoidCollisions ? undefined : disabledCollisionAvoidance}
          disableAnchorTracking={updatePositionStrategy === 'optimized'}
          positionMethod={positionMethod}
          sticky={sticky}
        >
          <BaseContextMenu.Popup
            ref={ref}
            className={withBaseClassName(contextMenuContentClassName, className)}
            finalFocus={onCloseAutoFocus ? finalFocus : undefined}
            style={withNoDragStyle(style)}
            render={(renderProps, state) =>
              renderCompatElement('div', render, asChild, children, renderProps, state)
            }
            {...props}
          >
            {asChild || render ? undefined : children}
          </BaseContextMenu.Popup>
        </BaseContextMenu.Positioner>
      </ContextMenuPortal>
    );
  }
);
ContextMenuContent.displayName = 'ContextMenuContent';

type ContextMenuItemProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseContextMenu.Item>,
  'className' | 'onClick' | 'render'
> & {
  asChild?: boolean;
  className?: StatefulClassName<BaseContextMenu.Item.State>;
  destructive?: boolean;
  inset?: boolean;
  onClick?: React.ComponentPropsWithoutRef<typeof BaseContextMenu.Item>['onClick'];
  onSelect?: (event: Event) => void;
  render?: CompatRender<BaseContextMenu.Item.State>;
  variant?: 'default' | 'destructive';
};

const ContextMenuItem = React.forwardRef<HTMLElement, ContextMenuItemProps>(
  (
    {
      asChild = false,
      children,
      className,
      destructive = false,
      inset = false,
      nativeButton: nativeButtonProp,
      onClick,
      onSelect,
      render,
      variant = 'default',
      ...props
    },
    ref
  ) => {
    const handleClick = React.useCallback(
      (event: BaseUIPreventableSyntheticEvent) => {
        onClick?.(event as Parameters<NonNullable<typeof onClick>>[0]);
        if (event.defaultPrevented) {
          event.preventBaseUIHandler?.();
          return;
        }
        callSelectHandler(onSelect, event);
      },
      [onClick, onSelect]
    );

    return (
      <BaseContextMenu.Item
        ref={ref}
        className={withItemClassName(className, inset, destructive || variant === 'destructive')}
        nativeButton={nativeButtonProp ?? (asChild ? isNativeButtonElement(children) : false)}
        onClick={handleClick as React.ComponentPropsWithoutRef<typeof BaseContextMenu.Item>['onClick']}
        render={(renderProps, state) =>
          renderCompatElement('div', render, asChild, children, renderProps, state)
        }
        {...props}
      >
        {asChild || render ? undefined : children}
      </BaseContextMenu.Item>
    );
  }
);
ContextMenuItem.displayName = 'ContextMenuItem';

type ContextMenuGroupProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseContextMenu.Group>,
  'render'
> & {
  asChild?: boolean;
  render?: CompatRender<BaseContextMenu.Group.State>;
};

const ContextMenuGroup = React.forwardRef<HTMLDivElement, ContextMenuGroupProps>(
  ({ asChild = false, children, render, ...props }, ref) => (
    <BaseContextMenu.Group
      ref={ref}
      render={(renderProps, state) =>
        renderCompatElement('div', render, asChild, children, renderProps, state)
      }
      {...props}
    >
      {asChild || render ? undefined : children}
    </BaseContextMenu.Group>
  )
);
ContextMenuGroup.displayName = 'ContextMenuGroup';

type ContextMenuLabelProps = Omit<React.HTMLAttributes<HTMLDivElement>, 'className'> & {
  asChild?: boolean;
  className?: string;
  inset?: boolean;
  render?: React.ReactElement;
};

const ContextMenuLabel = React.forwardRef<HTMLDivElement, ContextMenuLabelProps>(
  ({ asChild = false, children, className, inset = false, render, ...props }, ref) => {
    const labelProps = {
      ref,
      className: cn('px-2 py-1 text-micro font-medium text-ink-muted', inset && 'pl-8', className),
      ...props,
    };
    const child = asChild
      ? React.Children.only(children) as React.ReactElement<Record<string, unknown>>
      : undefined;
    const element = render ?? child;

    if (element) {
      return React.cloneElement(
        element,
        mergeProps(labelProps, element.props as React.ComponentPropsWithRef<React.ElementType>)
      );
    }

    return <div {...labelProps}>{children}</div>;
  }
);
ContextMenuLabel.displayName = 'ContextMenuLabel';

const ContextMenuSeparator = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseContextMenu.Separator>
>(({ className, ...props }, ref) => (
  <BaseContextMenu.Separator
    ref={ref}
    className={cn('my-0.5 h-px bg-border-subtle', className)}
    {...props}
  />
));
ContextMenuSeparator.displayName = 'ContextMenuSeparator';

const ContextMenuArrow = BaseContextMenu.Arrow;

const ContextMenu = Object.assign(ContextMenuRoot, {
  Root: ContextMenuRoot,
  Trigger: ContextMenuTrigger,
  Portal: ContextMenuPortal,
  Content: ContextMenuContent,
  Group: ContextMenuGroup,
  Label: ContextMenuLabel,
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Arrow: ContextMenuArrow,
});

export {
  ContextMenu,
  ContextMenuArrow,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuPortal,
  ContextMenuRoot,
  ContextMenuSeparator,
  ContextMenuTrigger,
};
