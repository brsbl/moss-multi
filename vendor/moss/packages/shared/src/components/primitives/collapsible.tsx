// ported-from: packages/shared/src/components/primitives/collapsible.tsx @ 762abb777
import * as React from 'react';
import { Collapsible as BaseCollapsible } from '@base-ui/react/collapsible';
import { mergeProps } from '@base-ui/react/merge-props';
import type { ComponentRenderFn, HTMLProps } from '@base-ui/react/types';

type CompatState = {
  open: boolean;
  disabled?: boolean;
};

type CompatRender<State extends CompatState> =
  | React.ReactElement
  | ComponentRenderFn<HTMLProps, State>;

function getCompatStateProps(state: CompatState) {
  return {
    'data-state': state.open ? 'open' : 'closed',
    'data-collapsible-state': state.open ? 'open' : 'closed',
    'data-disabled': state.disabled ? '' : undefined,
  };
}

function isNativeButtonElement(children: React.ReactNode) {
  return React.isValidElement(children) && children.type === 'button';
}

function renderCompatElement<State extends CompatState>(
  tagName: 'button' | 'div',
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

type CollapsibleRootProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseCollapsible.Root>,
  'onOpenChange' | 'render'
> & {
  asChild?: boolean;
  onOpenChange?: (open: boolean) => void;
  render?: CompatRender<BaseCollapsible.Root.State>;
};

const CollapsibleRoot = React.forwardRef<HTMLDivElement, CollapsibleRootProps>(
  ({ asChild = false, children, onOpenChange, render, ...props }, ref) => {
    const handleOpenChange = React.useCallback(
      (open: boolean) => {
        onOpenChange?.(open);
      },
      [onOpenChange]
    );

    return (
      <BaseCollapsible.Root
        ref={ref}
        onOpenChange={handleOpenChange}
        render={(renderProps, state) =>
          renderCompatElement('div', render, asChild, children, renderProps, state)
        }
        {...props}
      >
        {asChild || render ? undefined : children}
      </BaseCollapsible.Root>
    );
  }
);
CollapsibleRoot.displayName = 'CollapsibleRoot';

type CollapsibleTriggerProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseCollapsible.Trigger>,
  'render'
> & {
  asChild?: boolean;
  render?: CompatRender<BaseCollapsible.Trigger.State>;
};

const CollapsibleTrigger = React.forwardRef<HTMLElement, CollapsibleTriggerProps>(
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
    <BaseCollapsible.Trigger
      ref={ref as React.Ref<HTMLButtonElement>}
      nativeButton={nativeButtonProp ?? (asChild ? isNativeButtonElement(children) : true)}
      render={(renderProps, state) =>
        renderCompatElement('button', render, asChild, children, renderProps, state)
      }
      {...props}
    >
      {asChild || render ? undefined : children}
    </BaseCollapsible.Trigger>
  )
);
CollapsibleTrigger.displayName = 'CollapsibleTrigger';

type CollapsibleContentProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseCollapsible.Panel>,
  'render'
> & {
  asChild?: boolean;
  forceMount?: boolean;
  render?: CompatRender<BaseCollapsible.Panel.State>;
};

const CollapsibleContent = React.forwardRef<HTMLDivElement, CollapsibleContentProps>(
  (
    {
      asChild = false,
      children,
      forceMount,
      keepMounted,
      render,
      ...props
    },
    ref
  ) => (
    <BaseCollapsible.Panel
      ref={ref}
      keepMounted={forceMount ?? keepMounted}
      render={(renderProps, state) =>
        renderCompatElement('div', render, asChild, children, renderProps, state)
      }
      {...props}
    >
      {asChild || render ? undefined : children}
    </BaseCollapsible.Panel>
  )
);
CollapsibleContent.displayName = 'CollapsibleContent';

const Collapsible = {
  Root: CollapsibleRoot,
  Trigger: CollapsibleTrigger,
  Content: CollapsibleContent,
};

export {
  Collapsible,
  CollapsibleContent,
  CollapsibleRoot,
  CollapsibleTrigger,
};
