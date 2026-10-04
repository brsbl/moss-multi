// ported-from: packages/shared/src/components/primitives/dropdown-menu.tsx @ 762abb777
import * as React from 'react';
import { DirectionProvider } from '@base-ui/react/direction-provider';
import { Menu as BaseMenu } from '@base-ui/react/menu';
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

interface DropdownMenuCompatHandlers {
  onCloseAutoFocus?: (event: Event) => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onFocusOutside?: (event: PreventableNativeEvent) => void;
  onInteractOutside?: (event: PreventableNativeEvent) => void;
  onPointerDownOutside?: (event: PreventableNativeEvent) => void;
}

interface DropdownMenuCompatContextValue {
  handlersRef: React.MutableRefObject<DropdownMenuCompatHandlers>;
}

const DropdownMenuCompatContext = React.createContext<DropdownMenuCompatContextValue | null>(null);

const dropdownMenuContentClassName =
  'z-50 min-w-32 overflow-hidden rounded-md border border-border-subtle bg-surface-floating p-1 text-ink-default shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2';

const dropdownMenuItemClassName =
  'relative flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-surface-panel focus:bg-surface-panel data-[highlighted]:bg-surface-panel data-[disabled]:pointer-events-none data-[disabled]:opacity-50';

const destructiveItemClassName =
  'text-status-error-text focus:text-status-error-text data-[highlighted]:text-status-error-text';

const disabledCollisionAvoidance: BaseMenu.Positioner.Props['collisionAvoidance'] = {
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

function isNativeButtonElement(children: React.ReactNode) {
  return React.isValidElement(children) && children.type === 'button';
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
    cn(dropdownMenuItemClassName, inset && 'pl-8', destructive && destructiveItemClassName),
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

function renderCompatElement<State extends CompatState>(
  tagName: 'button' | 'div' | 'span',
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

function preventBaseMenuHandler(event: BaseUIPreventableSyntheticEvent) {
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
    preventBaseMenuHandler(event);
  }
}

type DropdownMenuRootProps<Payload = unknown> = Omit<
  BaseMenu.Root.Props<Payload>,
  'onOpenChange'
> & {
  dir?: 'ltr' | 'rtl';
  onOpenChange?: (open: boolean) => void;
};

function DropdownMenuRoot<Payload = unknown>({
  children,
  dir,
  onOpenChange,
  ...props
}: DropdownMenuRootProps<Payload>) {
  const handlersRef = React.useRef<DropdownMenuCompatHandlers>({});
  const context = React.useMemo(() => ({ handlersRef }), []);

  const handleOpenChange = React.useCallback(
    (open: boolean, eventDetails: BaseMenu.Root.ChangeEventDetails) => {
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
  ) satisfies NonNullable<BaseMenu.Root.Props<Payload>['onOpenChange']>;

  return (
    <DropdownMenuCompatContext.Provider value={context}>
      <DirectionProvider direction={dir}>
        <BaseMenu.Root onOpenChange={handleOpenChange} {...props}>
          {children}
        </BaseMenu.Root>
      </DirectionProvider>
    </DropdownMenuCompatContext.Provider>
  );
}
DropdownMenuRoot.displayName = 'DropdownMenuRoot';

type DropdownMenuTriggerProps<Payload = unknown> = Omit<
  BaseMenu.Trigger.Props<Payload>,
  'render'
> & {
  asChild?: boolean;
  render?: CompatRender<BaseMenu.Trigger.State>;
};

const DropdownMenuTrigger = React.forwardRef<HTMLElement, DropdownMenuTriggerProps>(
  (
    {
      asChild = false,
      children,
      nativeButton: nativeButtonProp,
      render,
      ...props
    },
    ref
  ) => (
    <BaseMenu.Trigger
      ref={ref as React.Ref<HTMLButtonElement>}
      nativeButton={nativeButtonProp ?? (asChild ? isNativeButtonElement(children) : true)}
      render={(renderProps, state) =>
        renderCompatElement('button', render, asChild, children, renderProps, state)
      }
      {...props}
    >
      {asChild || render ? undefined : children}
    </BaseMenu.Trigger>
  )
);
DropdownMenuTrigger.displayName = 'DropdownMenuTrigger';

type DropdownMenuPortalProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseMenu.Portal>,
  'keepMounted'
> & {
  forceMount?: boolean;
  keepMounted?: boolean;
};

const DropdownMenuPortal = React.forwardRef<HTMLDivElement, DropdownMenuPortalProps>(
  ({ forceMount, keepMounted, ...props }, ref) => (
    <BaseMenu.Portal
      ref={ref}
      keepMounted={keepMounted ?? forceMount}
      // moss-multi seam: overlay-surface (A§19, the floating detector's allowlist)
      data-overlay-surface=""
      {...props}
    />
  )
);
DropdownMenuPortal.displayName = 'DropdownMenuPortal';

type DropdownMenuPositionerProps = Pick<
  BaseMenu.Positioner.Props,
  | 'align'
  | 'alignOffset'
  | 'anchor'
  | 'arrowPadding'
  | 'collisionBoundary'
  | 'collisionPadding'
  | 'positionMethod'
  | 'side'
  | 'sideOffset'
  | 'sticky'
>;

type DropdownMenuContentProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseMenu.Popup>,
  'className' | 'finalFocus' | 'render' | 'style'
> &
  DropdownMenuPositionerProps & {
    asChild?: boolean;
    avoidCollisions?: boolean;
    className?: StatefulClassName<BaseMenu.Popup.State>;
    forceMount?: boolean;
    onCloseAutoFocus?: (event: Event) => void;
    onEscapeKeyDown?: (event: KeyboardEvent) => void;
    onFocusOutside?: (event: PreventableNativeEvent) => void;
    onInteractOutside?: (event: PreventableNativeEvent) => void;
    onOpenAutoFocus?: (event: Event) => void;
    onPointerDownOutside?: (event: PreventableNativeEvent) => void;
    render?: CompatRender<BaseMenu.Popup.State>;
    style?: StatefulStyle<BaseMenu.Popup.State>;
    updatePositionStrategy?: 'optimized' | 'always';
  };

const DropdownMenuContent = React.forwardRef<HTMLDivElement, DropdownMenuContentProps>(
  (
    {
      align = 'center',
      alignOffset,
      anchor,
      arrowPadding,
      asChild = false,
      avoidCollisions = true,
      children,
      className,
      collisionBoundary,
      collisionPadding,
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
      sideOffset = 8,
      sticky,
      style,
      updatePositionStrategy,
      ...props
    },
    ref
  ) => {
    const context = React.useContext(DropdownMenuCompatContext);

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
      <DropdownMenuPortal forceMount={forceMount}>
        <BaseMenu.Positioner
          render={(renderProps) => (
            <div
              {...renderProps}
              className={cn(renderProps.className, 'z-50')}
            />
          )}
          side={side}
          align={align}
          anchor={anchor}
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
          <BaseMenu.Popup
            ref={ref}
            className={withBaseClassName(dropdownMenuContentClassName, className)}
            finalFocus={onCloseAutoFocus ? finalFocus : undefined}
            style={withNoDragStyle(style)}
            render={(renderProps, state) =>
              renderCompatElement('div', render, asChild, children, renderProps, state)
            }
            {...props}
          >
            {asChild || render ? undefined : children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </DropdownMenuPortal>
    );
  }
);
DropdownMenuContent.displayName = 'DropdownMenuContent';

type DropdownMenuItemProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseMenu.Item>,
  'className' | 'onClick' | 'render'
> & {
  asChild?: boolean;
  className?: StatefulClassName<BaseMenu.Item.State>;
  destructive?: boolean;
  inset?: boolean;
  onClick?: React.ComponentPropsWithoutRef<typeof BaseMenu.Item>['onClick'];
  onSelect?: (event: Event) => void;
  render?: CompatRender<BaseMenu.Item.State>;
  variant?: 'default' | 'destructive';
};

const DropdownMenuItem = React.forwardRef<HTMLElement, DropdownMenuItemProps>(
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
      <BaseMenu.Item
        ref={ref}
        className={withItemClassName(className, inset, destructive || variant === 'destructive')}
        nativeButton={nativeButtonProp ?? (asChild ? isNativeButtonElement(children) : false)}
        onClick={handleClick as React.ComponentPropsWithoutRef<typeof BaseMenu.Item>['onClick']}
        render={(renderProps, state) =>
          renderCompatElement('div', render, asChild, children, renderProps, state)
        }
        {...props}
      >
        {asChild || render ? undefined : children}
      </BaseMenu.Item>
    );
  }
);
DropdownMenuItem.displayName = 'DropdownMenuItem';

type DropdownMenuCheckboxItemProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseMenu.CheckboxItem>,
  'className' | 'onCheckedChange' | 'onClick' | 'render'
> & {
  asChild?: boolean;
  className?: StatefulClassName<BaseMenu.CheckboxItem.State>;
  destructive?: boolean;
  inset?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  onClick?: React.ComponentPropsWithoutRef<typeof BaseMenu.CheckboxItem>['onClick'];
  onSelect?: (event: Event) => void;
  render?: CompatRender<BaseMenu.CheckboxItem.State>;
  variant?: 'default' | 'destructive';
};

const DropdownMenuCheckboxItem = React.forwardRef<HTMLElement, DropdownMenuCheckboxItemProps>(
  (
    {
      asChild = false,
      children,
      className,
      destructive = false,
      inset = false,
      nativeButton: nativeButtonProp,
      onCheckedChange,
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

    const handleCheckedChange = React.useCallback(
      (checked: boolean) => {
        onCheckedChange?.(checked);
      },
      [onCheckedChange]
    );

    return (
      <BaseMenu.CheckboxItem
        ref={ref}
        className={withItemClassName(className, inset, destructive || variant === 'destructive')}
        nativeButton={nativeButtonProp ?? (asChild ? isNativeButtonElement(children) : false)}
        onCheckedChange={handleCheckedChange}
        onClick={handleClick as React.ComponentPropsWithoutRef<typeof BaseMenu.CheckboxItem>['onClick']}
        render={(renderProps, state) =>
          renderCompatElement('div', render, asChild, children, renderProps, state)
        }
        {...props}
      >
        {asChild || render ? undefined : children}
      </BaseMenu.CheckboxItem>
    );
  }
);
DropdownMenuCheckboxItem.displayName = 'DropdownMenuCheckboxItem';

type DropdownMenuRadioGroupProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseMenu.RadioGroup>,
  'onValueChange'
> & {
  onValueChange?: (value: string) => void;
};

const DropdownMenuRadioGroup = React.forwardRef<HTMLDivElement, DropdownMenuRadioGroupProps>(
  ({ onValueChange, ...props }, ref) => {
    const handleValueChange = React.useCallback(
      (value: string) => {
        onValueChange?.(value);
      },
      [onValueChange]
    );

    return (
      <BaseMenu.RadioGroup
        ref={ref}
        onValueChange={onValueChange ? handleValueChange : undefined}
        {...props}
      />
    );
  }
);
DropdownMenuRadioGroup.displayName = 'DropdownMenuRadioGroup';

type DropdownMenuRadioItemProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseMenu.RadioItem>,
  'className' | 'onClick' | 'render'
> & {
  asChild?: boolean;
  className?: StatefulClassName<BaseMenu.RadioItem.State>;
  destructive?: boolean;
  inset?: boolean;
  onClick?: React.ComponentPropsWithoutRef<typeof BaseMenu.RadioItem>['onClick'];
  onSelect?: (event: Event) => void;
  render?: CompatRender<BaseMenu.RadioItem.State>;
  variant?: 'default' | 'destructive';
};

const DropdownMenuRadioItem = React.forwardRef<HTMLElement, DropdownMenuRadioItemProps>(
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
      <BaseMenu.RadioItem
        ref={ref}
        className={withItemClassName(className, inset, destructive || variant === 'destructive')}
        nativeButton={nativeButtonProp ?? (asChild ? isNativeButtonElement(children) : false)}
        onClick={handleClick as React.ComponentPropsWithoutRef<typeof BaseMenu.RadioItem>['onClick']}
        render={(renderProps, state) =>
          renderCompatElement('div', render, asChild, children, renderProps, state)
        }
        {...props}
      >
        {asChild || render ? undefined : children}
      </BaseMenu.RadioItem>
    );
  }
);
DropdownMenuRadioItem.displayName = 'DropdownMenuRadioItem';

type DropdownMenuSubProps = Omit<
  BaseMenu.SubmenuRoot.Props,
  'onOpenChange'
> & {
  onOpenChange?: (open: boolean) => void;
};

function DropdownMenuSub({ onOpenChange, ...props }: DropdownMenuSubProps) {
  const handleOpenChange = React.useCallback(
    (open: boolean) => {
      onOpenChange?.(open);
    },
    [onOpenChange]
  ) satisfies NonNullable<BaseMenu.SubmenuRoot.Props['onOpenChange']>;

  return (
    <BaseMenu.SubmenuRoot
      onOpenChange={onOpenChange ? handleOpenChange : undefined}
      {...props}
    />
  );
}
DropdownMenuSub.displayName = 'DropdownMenuSub';

type DropdownMenuSubTriggerProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseMenu.SubmenuTrigger>,
  'className' | 'render'
> & {
  asChild?: boolean;
  className?: StatefulClassName<BaseMenu.SubmenuTrigger.State>;
  inset?: boolean;
  render?: CompatRender<BaseMenu.SubmenuTrigger.State>;
};

const DropdownMenuSubTrigger = React.forwardRef<HTMLElement, DropdownMenuSubTriggerProps>(
  (
    {
      asChild = false,
      children,
      className,
      inset = false,
      nativeButton: nativeButtonProp,
      render,
      ...props
    },
    ref
  ) => (
    <BaseMenu.SubmenuTrigger
      ref={ref}
      className={withItemClassName(className, inset, false)}
      nativeButton={nativeButtonProp ?? (asChild ? isNativeButtonElement(children) : false)}
      render={(renderProps, state) =>
        renderCompatElement('div', render, asChild, children, renderProps, state)
      }
      {...props}
    >
      {asChild || render ? undefined : children}
    </BaseMenu.SubmenuTrigger>
  )
);
DropdownMenuSubTrigger.displayName = 'DropdownMenuSubTrigger';

const DropdownMenuSubContent = DropdownMenuContent;

type DropdownMenuGroupProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseMenu.Group>,
  'render'
> & {
  asChild?: boolean;
  render?: CompatRender<BaseMenu.Group.State>;
};

const DropdownMenuGroup = React.forwardRef<HTMLDivElement, DropdownMenuGroupProps>(
  ({ asChild = false, children, render, ...props }, ref) => (
    <BaseMenu.Group
      ref={ref}
      render={(renderProps, state) =>
        renderCompatElement('div', render, asChild, children, renderProps, state)
      }
      {...props}
    >
      {asChild || render ? undefined : children}
    </BaseMenu.Group>
  )
);
DropdownMenuGroup.displayName = 'DropdownMenuGroup';

type DropdownMenuLabelProps = Omit<React.HTMLAttributes<HTMLDivElement>, 'className'> & {
  asChild?: boolean;
  className?: string;
  inset?: boolean;
  render?: React.ReactElement;
};

const DropdownMenuLabel = React.forwardRef<HTMLDivElement, DropdownMenuLabelProps>(
  ({ asChild = false, children, className, inset = false, render, ...props }, ref) => {
    const labelProps = {
      ref,
      className: cn('px-2 py-1.5 text-sm font-semibold text-ink-default', inset && 'pl-8', className),
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
DropdownMenuLabel.displayName = 'DropdownMenuLabel';

const DropdownMenuSeparator = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseMenu.Separator>
>(({ className, ...props }, ref) => (
  <BaseMenu.Separator
    ref={ref}
    className={cn('-mx-1 my-1 h-px bg-border-subtle', className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator';

const DropdownMenuItemIndicator = BaseMenu.CheckboxItemIndicator;
const DropdownMenuCheckboxItemIndicator = BaseMenu.CheckboxItemIndicator;
const DropdownMenuRadioItemIndicator = BaseMenu.RadioItemIndicator;
const DropdownMenuArrow = BaseMenu.Arrow;
const DropdownMenuViewport = BaseMenu.Viewport;
const DropdownMenuHandle = BaseMenu.Handle;

function DropdownMenuShortcut({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn('ml-auto text-xs tracking-widest text-ink-muted', className)}
      {...props}
    />
  );
}
DropdownMenuShortcut.displayName = 'DropdownMenuShortcut';

const DropdownMenu = Object.assign(DropdownMenuRoot, {
  Root: DropdownMenuRoot,
  Trigger: DropdownMenuTrigger,
  Portal: DropdownMenuPortal,
  Content: DropdownMenuContent,
  Group: DropdownMenuGroup,
  Label: DropdownMenuLabel,
  Item: DropdownMenuItem,
  CheckboxItem: DropdownMenuCheckboxItem,
  RadioGroup: DropdownMenuRadioGroup,
  RadioItem: DropdownMenuRadioItem,
  ItemIndicator: DropdownMenuItemIndicator,
  CheckboxItemIndicator: DropdownMenuCheckboxItemIndicator,
  RadioItemIndicator: DropdownMenuRadioItemIndicator,
  Separator: DropdownMenuSeparator,
  Arrow: DropdownMenuArrow,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  Shortcut: DropdownMenuShortcut,
  Viewport: DropdownMenuViewport,
  createHandle: BaseMenu.createHandle,
  Handle: DropdownMenuHandle,
});

export {
  DropdownMenu,
  DropdownMenuArrow,
  DropdownMenuCheckboxItem,
  DropdownMenuCheckboxItemIndicator,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuHandle,
  DropdownMenuItem,
  DropdownMenuItemIndicator,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRadioItemIndicator,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  DropdownMenuViewport,
};
