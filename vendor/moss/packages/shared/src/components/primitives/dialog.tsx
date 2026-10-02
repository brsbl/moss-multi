// ported-from: packages/shared/src/components/primitives/dialog.tsx @ 762abb777
import * as React from 'react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { mergeProps } from '@base-ui/react/merge-props';
import type { ComponentRenderFn, HTMLProps } from '@base-ui/react/types';

import { cn } from '@/lib/utils';

type CompatState = {
  disabled?: boolean;
  open?: boolean;
};

type CompatRender<State extends CompatState> =
  | React.ReactElement
  | ComponentRenderFn<HTMLProps, State>;

type StatefulClassName<State extends CompatState> =
  | string
  | ((state: State) => string | undefined);

type PreventableNativeEvent = Event & {
  preventDefault: () => void;
};

interface DialogCompatHandlers {
  onCloseAutoFocus?: (event: Event) => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onFocusOutside?: (event: PreventableNativeEvent) => void;
  onInteractOutside?: (event: PreventableNativeEvent) => void;
  onOpenAutoFocus?: (event: Event) => void;
  onPointerDownOutside?: (event: PreventableNativeEvent) => void;
}

interface DialogCompatContextValue {
  handlersRef: React.MutableRefObject<DialogCompatHandlers>;
}

const DialogCompatContext = React.createContext<DialogCompatContextValue | null>(null);

function getCompatStateProps(state: CompatState) {
  return {
    'data-state': typeof state.open === 'boolean' ? state.open ? 'open' : 'closed' : undefined,
    'data-disabled': state.disabled ? '' : undefined,
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

function renderCompatElement<State extends CompatState>(
  tagName: 'button' | 'div' | 'h2' | 'p',
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

type DialogRootProps<Payload = unknown> = Omit<
  BaseDialog.Root.Props<Payload>,
  'onOpenChange'
> & {
  onOpenChange?: (open: boolean) => void;
};

function DialogRoot<Payload = unknown>({
  children,
  onOpenChange,
  ...props
}: DialogRootProps<Payload>) {
  const handlersRef = React.useRef<DialogCompatHandlers>({});
  const context = React.useMemo(() => ({ handlersRef }), []);

  const handleOpenChange = React.useCallback(
    (open: boolean, eventDetails: BaseDialog.Root.ChangeEventDetails) => {
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
  ) satisfies NonNullable<BaseDialog.Root.Props<Payload>['onOpenChange']>;

  return (
    <DialogCompatContext.Provider value={context}>
      <BaseDialog.Root onOpenChange={handleOpenChange} {...props}>
        {children}
      </BaseDialog.Root>
    </DialogCompatContext.Provider>
  );
}
DialogRoot.displayName = 'DialogRoot';

type DialogTriggerProps<Payload = unknown> = Omit<
  BaseDialog.Trigger.Props<Payload>,
  'render'
> & {
  asChild?: boolean;
  render?: CompatRender<BaseDialog.Trigger.State>;
};

const DialogTrigger = React.forwardRef<HTMLElement, DialogTriggerProps>(
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
    <BaseDialog.Trigger
      ref={ref as React.Ref<HTMLButtonElement>}
      nativeButton={nativeButtonProp ?? (asChild ? isNativeButtonElement(children) : true)}
      render={(renderProps, state) =>
        renderCompatElement('button', render, asChild, children, renderProps, state)
      }
      {...props}
    >
      {asChild || render ? undefined : children}
    </BaseDialog.Trigger>
  )
);
DialogTrigger.displayName = 'DialogTrigger';

type DialogPortalProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseDialog.Portal>,
  'keepMounted'
> & {
  forceMount?: boolean;
  keepMounted?: boolean;
};

const DialogPortal = React.forwardRef<HTMLDivElement, DialogPortalProps>(
  ({ forceMount, keepMounted, ...props }, ref) => (
    <BaseDialog.Portal ref={ref} keepMounted={keepMounted ?? forceMount} {...props} />
  )
);
DialogPortal.displayName = 'DialogPortal';

type DialogOverlayProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseDialog.Backdrop>,
  'render'
> & {
  asChild?: boolean;
  render?: CompatRender<BaseDialog.Backdrop.State>;
};

const DialogOverlay = React.forwardRef<HTMLDivElement, DialogOverlayProps>(
  ({ asChild = false, children, className, render, ...props }, ref) => (
    <BaseDialog.Backdrop
      ref={ref}
      className={withBaseClassName('', className)}
      render={(renderProps, state) =>
        renderCompatElement('div', render, asChild, children, renderProps, state)
      }
      {...props}
    >
      {asChild || render ? undefined : children}
    </BaseDialog.Backdrop>
  )
);
DialogOverlay.displayName = 'DialogOverlay';

type DialogContentProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseDialog.Popup>,
  'className' | 'finalFocus' | 'initialFocus' | 'render'
> & {
  asChild?: boolean;
  className?: StatefulClassName<BaseDialog.Popup.State>;
  onCloseAutoFocus?: (event: Event) => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onFocusOutside?: (event: PreventableNativeEvent) => void;
  onInteractOutside?: (event: PreventableNativeEvent) => void;
  onOpenAutoFocus?: (event: Event) => void;
  onPointerDownOutside?: (event: PreventableNativeEvent) => void;
  render?: CompatRender<BaseDialog.Popup.State>;
};

const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(
  (
    {
      asChild = false,
      children,
      className,
      onCloseAutoFocus,
      onEscapeKeyDown,
      onFocusOutside,
      onInteractOutside,
      onOpenAutoFocus,
      onPointerDownOutside,
      render,
      ...props
    },
    ref
  ) => {
    const context = React.useContext(DialogCompatContext);

    React.useEffect(() => {
      if (!context) return;
      context.handlersRef.current = {
        onCloseAutoFocus,
        onEscapeKeyDown,
        onFocusOutside,
        onInteractOutside,
        onOpenAutoFocus,
        onPointerDownOutside,
      };
      return () => {
        const current = context.handlersRef.current;
        if (
          current.onCloseAutoFocus === onCloseAutoFocus &&
          current.onEscapeKeyDown === onEscapeKeyDown &&
          current.onFocusOutside === onFocusOutside &&
          current.onInteractOutside === onInteractOutside &&
          current.onOpenAutoFocus === onOpenAutoFocus &&
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
      onOpenAutoFocus,
      onPointerDownOutside,
    ]);

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
      <BaseDialog.Popup
        ref={ref}
        className={withBaseClassName('', className)}
        initialFocus={onOpenAutoFocus ? initialFocus : undefined}
        finalFocus={onCloseAutoFocus ? finalFocus : undefined}
        render={(renderProps, state) =>
          renderCompatElement('div', render, asChild, children, renderProps, state)
        }
        {...props}
      >
        {asChild || render ? undefined : children}
      </BaseDialog.Popup>
    );
  }
);
DialogContent.displayName = 'DialogContent';

type DialogTitleProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseDialog.Title>,
  'render'
> & {
  asChild?: boolean;
  render?: CompatRender<BaseDialog.Title.State>;
};

const DialogTitle = React.forwardRef<HTMLHeadingElement, DialogTitleProps>(
  ({ asChild = false, children, className, render, ...props }, ref) => (
    <BaseDialog.Title
      ref={ref}
      className={withBaseClassName('text-sm font-semibold text-ink-default', className)}
      render={(renderProps, state) =>
        renderCompatElement('h2', render, asChild, children, renderProps, state)
      }
      {...props}
    >
      {asChild || render ? undefined : children}
    </BaseDialog.Title>
  )
);
DialogTitle.displayName = 'DialogTitle';

type DialogDescriptionProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseDialog.Description>,
  'render'
> & {
  asChild?: boolean;
  render?: CompatRender<BaseDialog.Description.State>;
};

const DialogDescription = React.forwardRef<HTMLParagraphElement, DialogDescriptionProps>(
  ({ asChild = false, children, className, render, ...props }, ref) => (
    <BaseDialog.Description
      ref={ref}
      className={withBaseClassName('', className)}
      render={(renderProps, state) =>
        renderCompatElement('p', render, asChild, children, renderProps, state)
      }
      {...props}
    >
      {asChild || render ? undefined : children}
    </BaseDialog.Description>
  )
);
DialogDescription.displayName = 'DialogDescription';

type DialogCloseProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseDialog.Close>,
  'render'
> & {
  asChild?: boolean;
  render?: CompatRender<BaseDialog.Close.State>;
};

const DialogClose = React.forwardRef<HTMLElement, DialogCloseProps>(
  (
    {
      asChild = false,
      children,
      className,
      nativeButton: nativeButtonProp,
      render,
      ...props
    },
    ref
  ) => (
    <BaseDialog.Close
      ref={ref as React.Ref<HTMLButtonElement>}
      className={withBaseClassName('', className)}
      nativeButton={nativeButtonProp ?? (asChild ? isNativeButtonElement(children) : true)}
      render={(renderProps, state) =>
        renderCompatElement('button', render, asChild, children, renderProps, state)
      }
      {...props}
    >
      {asChild || render ? undefined : children}
    </BaseDialog.Close>
  )
);
DialogClose.displayName = 'DialogClose';

const DialogViewport = BaseDialog.Viewport;
const DialogBackdrop = DialogOverlay;
const DialogPopup = DialogContent;

const Dialog = Object.assign(DialogRoot, {
  Root: DialogRoot,
  Trigger: DialogTrigger,
  Portal: DialogPortal,
  Overlay: DialogOverlay,
  Backdrop: DialogBackdrop,
  Content: DialogContent,
  Popup: DialogPopup,
  Title: DialogTitle,
  Description: DialogDescription,
  Close: DialogClose,
  Viewport: DialogViewport,
  createHandle: BaseDialog.createHandle,
  Handle: BaseDialog.Handle,
});

export {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPopup,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
  DialogViewport,
};
