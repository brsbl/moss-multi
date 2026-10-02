// ported-from: packages/shared/src/components/primitives/slot.tsx @ 762abb777
import * as React from 'react';

type AnyProps = Record<string, unknown> & {
  children?: React.ReactNode;
  className?: string;
  ref?: React.Ref<unknown>;
  style?: React.CSSProperties;
};

export interface SlotProps extends React.HTMLAttributes<HTMLElement> {
  children?: React.ReactNode;
}

interface SlottableProps {
  children: React.ReactNode;
}

function setRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') {
    ref(value);
    return;
  }

  if (ref) {
    ref.current = value;
  }
}

function composeRefs<T>(...refs: Array<React.Ref<T> | undefined>) {
  return (node: T | null) => {
    for (const ref of refs) {
      setRef(ref, node);
    }
  };
}

function getElementRef(element: React.ReactElement<AnyProps>) {
  let getter = Object.getOwnPropertyDescriptor(element.props, 'ref')?.get;
  let mayWarn = Boolean(getter && 'isReactWarning' in getter && getter.isReactWarning);

  if (mayWarn) {
    return (element as React.ReactElement & { ref?: React.Ref<unknown> }).ref;
  }

  getter = Object.getOwnPropertyDescriptor(element, 'ref')?.get;
  mayWarn = Boolean(getter && 'isReactWarning' in getter && getter.isReactWarning);

  if (mayWarn) {
    return element.props.ref;
  }

  return element.props.ref ?? (element as React.ReactElement & { ref?: React.Ref<unknown> }).ref;
}

function mergeProps(slotProps: AnyProps, childProps: AnyProps) {
  const overrideProps = { ...childProps };

  for (const propName in childProps) {
    const slotPropValue = slotProps[propName];
    const childPropValue = childProps[propName];
    const isHandler = /^on[A-Z]/.test(propName);

    if (isHandler) {
      if (typeof slotPropValue === 'function' && typeof childPropValue === 'function') {
        overrideProps[propName] = (...args: unknown[]) => {
          childPropValue(...args);
          slotPropValue(...args);
        };
      } else if (typeof slotPropValue === 'function') {
        overrideProps[propName] = slotPropValue;
      }
    } else if (propName === 'style') {
      overrideProps[propName] = {
        ...(slotPropValue as React.CSSProperties | undefined),
        ...(childPropValue as React.CSSProperties | undefined),
      };
    } else if (propName === 'className') {
      overrideProps[propName] = [slotPropValue, childPropValue].filter(Boolean).join(' ');
    }
  }

  return { ...slotProps, ...overrideProps };
}

function isSlottable(
  child: React.ReactNode
): child is React.ReactElement<SlottableProps, typeof Slottable> {
  return React.isValidElement(child) && child.type === Slottable;
}

const SlotClone = React.forwardRef<HTMLElement, SlotProps>(
  ({ children, ...slotProps }, forwardedRef) => {
    if (React.isValidElement<AnyProps>(children)) {
      const childRef = getElementRef(children);
      const props = mergeProps(slotProps, children.props);

      if (children.type !== React.Fragment) {
        props.ref = forwardedRef
          ? composeRefs(forwardedRef, childRef as React.Ref<HTMLElement> | undefined)
          : childRef;
      }

      return React.cloneElement(children, props);
    }

    return React.Children.count(children) > 1 ? React.Children.only(null) : null;
  }
);
SlotClone.displayName = 'SlotClone';

const Slot = React.forwardRef<HTMLElement, SlotProps>(
  ({ children, ...slotProps }, forwardedRef) => {
    const childrenArray = React.Children.toArray(children);
    const slottable = childrenArray.find(isSlottable);

    if (slottable) {
      const newElement = slottable.props.children;
      const newChildren = childrenArray.map((child) => {
        if (child !== slottable) return child;
        if (React.Children.count(newElement) > 1) return React.Children.only(null);
        return React.isValidElement<React.PropsWithChildren>(newElement)
          ? newElement.props.children
          : null;
      });

      return (
        <SlotClone {...slotProps} ref={forwardedRef}>
          {React.isValidElement<React.PropsWithChildren>(newElement)
            ? React.cloneElement(newElement, undefined, newChildren)
            : null}
        </SlotClone>
      );
    }

    return (
      <SlotClone {...slotProps} ref={forwardedRef}>
        {children}
      </SlotClone>
    );
  }
);
Slot.displayName = 'Slot';

function Slottable({ children }: SlottableProps) {
  return <>{children}</>;
}
Slottable.displayName = 'Slottable';

const Root = Slot;

export { Root, Slot, Slottable };
