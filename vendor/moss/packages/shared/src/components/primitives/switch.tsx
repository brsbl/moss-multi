// ported-from: packages/shared/src/components/primitives/switch.tsx @ 762abb777
import * as React from 'react';
import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { mergeProps } from '@base-ui/react/merge-props';
import type { ComponentRenderFn, HTMLProps } from '@base-ui/react/types';

import { cn } from '@/lib/utils';

type SwitchState = BaseSwitch.Root.State;

type CompatRender<State extends SwitchState> =
  | React.ReactElement
  | ComponentRenderFn<HTMLProps, State>;

function getCompatStateProps(state: SwitchState) {
  return {
    'data-state': state.checked ? 'checked' : 'unchecked',
    'data-disabled': state.disabled ? '' : undefined,
    'data-readonly': state.readOnly ? '' : undefined,
    'data-required': state.required ? '' : undefined,
  };
}

function isNativeButtonElement(children: React.ReactNode) {
  return React.isValidElement(children) && children.type === 'button';
}

function renderCompatElement<State extends SwitchState>(
  tagName: 'span',
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

type StatefulClassName<State extends SwitchState> =
  | string
  | ((state: State) => string | undefined);

function withBaseClassName<State extends SwitchState>(
  baseClassName: string,
  className: StatefulClassName<State> | undefined
) {
  if (typeof className === 'function') {
    return (state: State) => cn(baseClassName, className(state));
  }

  return cn(baseClassName, className);
}

type SwitchRootProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseSwitch.Root>,
  'onCheckedChange' | 'render'
> & {
  asChild?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  render?: CompatRender<BaseSwitch.Root.State>;
};

const switchRootClassName =
  'relative inline-flex h-6 w-7 shrink-0 cursor-pointer items-center rounded-full before:pointer-events-none before:absolute before:inset-x-0 before:top-1 before:h-4 before:rounded-full before:border before:border-surface-glass-border before:bg-surface-panel/70 before:shadow-inner before:transition-colors before:content-[""] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15 data-[state=checked]:before:border-accent-brand/50 data-[state=checked]:before:bg-accent-brand data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50';

const SwitchRoot = React.forwardRef<HTMLElement, SwitchRootProps>(
  (
    {
      asChild = false,
      children,
      className,
      nativeButton: nativeButtonProp,
      onCheckedChange,
      render,
      ...props
    },
    ref
  ) => {
    const handleCheckedChange = React.useCallback(
      (checked: boolean) => {
        onCheckedChange?.(checked);
      },
      [onCheckedChange]
    );

    return (
      <BaseSwitch.Root
        ref={ref}
        className={withBaseClassName(switchRootClassName, className)}
        nativeButton={nativeButtonProp ?? (asChild ? isNativeButtonElement(children) : false)}
        onCheckedChange={onCheckedChange ? handleCheckedChange : undefined}
        render={(renderProps, state) =>
          renderCompatElement('span', render, asChild, children, renderProps, state)
        }
        {...props}
      >
        {asChild || render ? undefined : children}
      </BaseSwitch.Root>
    );
  }
);
SwitchRoot.displayName = 'SwitchRoot';

type SwitchThumbProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseSwitch.Thumb>,
  'render'
> & {
  asChild?: boolean;
  render?: CompatRender<BaseSwitch.Thumb.State>;
};

const switchThumbClassName =
  'pointer-events-none relative ml-0.5 block h-3 w-3 rounded-full bg-ink-inverse shadow-floating ring-1 ring-border-strong/30 transition-transform data-[state=checked]:translate-x-3 data-[state=unchecked]:translate-x-0';

const SwitchThumb = React.forwardRef<HTMLSpanElement, SwitchThumbProps>(
  ({ asChild = false, children, className, render, ...props }, ref) => (
    <BaseSwitch.Thumb
      ref={ref}
      className={withBaseClassName(switchThumbClassName, className)}
      render={(renderProps, state) =>
        renderCompatElement('span', render, asChild, children, renderProps, state)
      }
      {...props}
    >
      {asChild || render ? undefined : children}
    </BaseSwitch.Thumb>
  )
);
SwitchThumb.displayName = 'SwitchThumb';

const Switch = Object.assign(SwitchRoot, {
  Root: SwitchRoot,
  Thumb: SwitchThumb,
});

export {
  Switch,
  SwitchRoot,
  SwitchThumb,
};
