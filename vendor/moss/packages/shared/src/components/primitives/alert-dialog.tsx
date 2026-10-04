// ported-from: packages/shared/src/components/primitives/alert-dialog.tsx @ 762abb777
import * as React from 'react';
import { AlertDialog as BaseAlertDialog } from '@base-ui/react/alert-dialog';
import { mergeProps } from '@base-ui/react/merge-props';
import type { ComponentRenderFn, HTMLProps } from '@base-ui/react/types';

import { cn } from '@/lib/utils';
import { useNotePaneDialogPosition } from '@/components/ui/use-note-pane-dialog-position';

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

type AlertDialogRootProps<Payload = unknown> = Omit<
  BaseAlertDialog.Root.Props<Payload>,
  'onOpenChange'
> & {
  onOpenChange?: (open: boolean) => void;
};

function AlertDialogRoot<Payload = unknown>({
  onOpenChange,
  ...props
}: AlertDialogRootProps<Payload>) {
  const handleOpenChange = React.useCallback(
    (open: boolean) => {
      onOpenChange?.(open);
    },
    [onOpenChange]
  ) satisfies NonNullable<BaseAlertDialog.Root.Props<Payload>['onOpenChange']>;

  return (
    <BaseAlertDialog.Root
      onOpenChange={onOpenChange ? handleOpenChange : undefined}
      {...props}
    />
  );
}
AlertDialogRoot.displayName = 'AlertDialogRoot';

type AlertDialogTriggerProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseAlertDialog.Trigger>,
  'render'
> & {
  asChild?: boolean;
  render?: CompatRender<BaseAlertDialog.Trigger.State>;
};

const AlertDialogTrigger = React.forwardRef<HTMLElement, AlertDialogTriggerProps>(
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
    <BaseAlertDialog.Trigger
      ref={ref as React.Ref<HTMLButtonElement>}
      nativeButton={nativeButtonProp ?? (asChild ? isNativeButtonElement(children) : true)}
      render={(renderProps, state) =>
        renderCompatElement('button', render, asChild, children, renderProps, state)
      }
      {...props}
    >
      {asChild || render ? undefined : children}
    </BaseAlertDialog.Trigger>
  )
);
AlertDialogTrigger.displayName = 'AlertDialogTrigger';

// moss-multi seam: overlay-surface (A§19, the floating detector's allowlist)
const AlertDialogPortal = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseAlertDialog.Portal>
>((props, ref) => <BaseAlertDialog.Portal ref={ref} data-overlay-surface="" {...props} />);
AlertDialogPortal.displayName = 'AlertDialogPortal';

type AlertDialogOverlayProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseAlertDialog.Backdrop>,
  'render'
> & {
  asChild?: boolean;
  render?: CompatRender<BaseAlertDialog.Backdrop.State>;
};

const alertDialogOverlayClassName =
  'fixed inset-0 z-dialog-overlay bg-surface-modal-overlay-muted data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0';

const AlertDialogOverlay = React.forwardRef<HTMLDivElement, AlertDialogOverlayProps>(
  ({ asChild = false, children, className, render, ...props }, ref) => (
    <BaseAlertDialog.Backdrop
      ref={ref}
      className={withBaseClassName(alertDialogOverlayClassName, className)}
      data-moss-modal-overlay="true"
      render={(renderProps, state) =>
        renderCompatElement('div', render, asChild, children, renderProps, state)
      }
      {...props}
    >
      {asChild || render ? undefined : children}
    </BaseAlertDialog.Backdrop>
  )
);
AlertDialogOverlay.displayName = 'AlertDialogOverlay';

type AlertDialogContentProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseAlertDialog.Popup>,
  'render'
> & {
  asChild?: boolean;
  render?: CompatRender<BaseAlertDialog.Popup.State>;
};

const alertDialogContentClassName =
  'fixed left-1/2 top-1/2 z-dialog-content w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border-subtle bg-surface-linen p-5 text-ink-default shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95';

const AlertDialogContent = React.forwardRef<HTMLDivElement, AlertDialogContentProps>(
  ({ asChild = false, children, className, render, style, ...props }, ref) => {
    const dialogPositionStyle = useNotePaneDialogPosition({ open: true, maxWidthPx: 384 });

    return (
      <BaseAlertDialog.Popup
        ref={ref}
        data-remote-web-surface-blocking-dialog="true"
        // moss-multi seam: overlay-surface (A§19, the floating detector's allowlist)
        data-overlay-surface=""
        className={withBaseClassName(alertDialogContentClassName, className)}
        style={{ ...dialogPositionStyle, ...style }}
        render={(renderProps, state) =>
          renderCompatElement('div', render, asChild, children, renderProps, state)
        }
        {...props}
      >
        {asChild || render ? undefined : children}
      </BaseAlertDialog.Popup>
    );
  }
);
AlertDialogContent.displayName = 'AlertDialogContent';

type AlertDialogTitleProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseAlertDialog.Title>,
  'render'
> & {
  asChild?: boolean;
  render?: CompatRender<BaseAlertDialog.Title.State>;
};

const AlertDialogTitle = React.forwardRef<HTMLHeadingElement, AlertDialogTitleProps>(
  ({ asChild = false, children, className, render, ...props }, ref) => (
    <BaseAlertDialog.Title
      ref={ref}
      className={withBaseClassName('text-sm font-semibold text-ink-default', className)}
      render={(renderProps, state) =>
        renderCompatElement('h2', render, asChild, children, renderProps, state)
      }
      {...props}
    >
      {asChild || render ? undefined : children}
    </BaseAlertDialog.Title>
  )
);
AlertDialogTitle.displayName = 'AlertDialogTitle';

type AlertDialogDescriptionProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseAlertDialog.Description>,
  'render'
> & {
  asChild?: boolean;
  render?: CompatRender<BaseAlertDialog.Description.State>;
};

const AlertDialogDescription = React.forwardRef<
  HTMLParagraphElement,
  AlertDialogDescriptionProps
>(
  ({ asChild = false, children, className, render, ...props }, ref) => (
    <BaseAlertDialog.Description
      ref={ref}
      className={withBaseClassName('mt-2 text-xs leading-relaxed text-ink-muted', className)}
      render={(renderProps, state) =>
        renderCompatElement('p', render, asChild, children, renderProps, state)
      }
      {...props}
    >
      {asChild || render ? undefined : children}
    </BaseAlertDialog.Description>
  )
);
AlertDialogDescription.displayName = 'AlertDialogDescription';

type AlertDialogCloseButtonProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseAlertDialog.Close>,
  'render'
> & {
  asChild?: boolean;
  render?: CompatRender<BaseAlertDialog.Close.State>;
};

const alertDialogActionClassName =
  'inline-flex h-8 items-center justify-center rounded-md bg-accent-brand px-3 text-xs font-medium text-ink-on-accent shadow-sm transition-colors hover:bg-accent-brand-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-default/20 disabled:pointer-events-none disabled:opacity-50';

const AlertDialogAction = React.forwardRef<HTMLElement, AlertDialogCloseButtonProps>(
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
    <BaseAlertDialog.Close
      ref={ref as React.Ref<HTMLButtonElement>}
      className={withBaseClassName(alertDialogActionClassName, className)}
      nativeButton={nativeButtonProp ?? (asChild ? isNativeButtonElement(children) : true)}
      render={(renderProps, state) =>
        renderCompatElement('button', render, asChild, children, renderProps, state)
      }
      {...props}
    >
      {asChild || render ? undefined : children}
    </BaseAlertDialog.Close>
  )
);
AlertDialogAction.displayName = 'AlertDialogAction';

const alertDialogCancelClassName =
  'inline-flex h-8 items-center justify-center rounded-md border border-border-subtle bg-surface-linen px-3 text-xs font-medium text-ink-default shadow-sm transition-colors hover:bg-surface-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-default/20 disabled:pointer-events-none disabled:opacity-50';

const AlertDialogCancel = React.forwardRef<HTMLElement, AlertDialogCloseButtonProps>(
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
    <BaseAlertDialog.Close
      ref={ref as React.Ref<HTMLButtonElement>}
      className={withBaseClassName(alertDialogCancelClassName, className)}
      nativeButton={nativeButtonProp ?? (asChild ? isNativeButtonElement(children) : true)}
      render={(renderProps, state) =>
        renderCompatElement('button', render, asChild, children, renderProps, state)
      }
      {...props}
    >
      {asChild || render ? undefined : children}
    </BaseAlertDialog.Close>
  )
);
AlertDialogCancel.displayName = 'AlertDialogCancel';

const AlertDialog = Object.assign(AlertDialogRoot, {
  Root: AlertDialogRoot,
  Trigger: AlertDialogTrigger,
  Portal: AlertDialogPortal,
  Overlay: AlertDialogOverlay,
  Content: AlertDialogContent,
  Title: AlertDialogTitle,
  Description: AlertDialogDescription,
  Action: AlertDialogAction,
  Cancel: AlertDialogCancel,
});

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
  AlertDialogTrigger,
};
