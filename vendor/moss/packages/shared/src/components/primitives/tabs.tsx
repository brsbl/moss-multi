// ported-from: packages/shared/src/components/primitives/tabs.tsx @ 762abb777
import * as React from 'react';
import { Tabs as BaseTabs } from '@base-ui/react/tabs';

type TabsValue = string;

type TabsRootProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseTabs.Root>,
  'defaultValue' | 'onValueChange' | 'value'
> & {
  defaultValue?: TabsValue;
  onValueChange?: (value: TabsValue) => void;
  value?: TabsValue;
};

const TabsRoot = React.forwardRef<HTMLDivElement, TabsRootProps>(
  ({ onValueChange, ...props }, ref) => {
    const handleValueChange = React.useCallback(
      (value: BaseTabs.Tab.Value) => {
        if (value == null) return;
        onValueChange?.(String(value));
      },
      [onValueChange]
    );

    return (
      <BaseTabs.Root
        ref={ref}
        onValueChange={onValueChange ? handleValueChange : undefined}
        {...props}
      />
    );
  }
);
TabsRoot.displayName = 'TabsRoot';

const TabsList = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseTabs.List>
>((props, ref) => <BaseTabs.List ref={ref} {...props} />);
TabsList.displayName = 'TabsList';

type TabsTriggerProps = React.ComponentPropsWithoutRef<typeof BaseTabs.Tab> & {
  asChild?: boolean;
};

const TabsTrigger = React.forwardRef<HTMLElement, TabsTriggerProps>(
  ({ asChild = false, children, render, ...props }, ref) => (
    <BaseTabs.Tab
      ref={ref}
      render={render ?? (asChild ? React.Children.only(children) as React.ReactElement : undefined)}
      {...props}
    >
      {asChild ? undefined : children}
    </BaseTabs.Tab>
  )
);
TabsTrigger.displayName = 'TabsTrigger';

type TabsContentProps = Omit<
  React.ComponentPropsWithoutRef<typeof BaseTabs.Panel>,
  'keepMounted'
> & {
  forceMount?: boolean;
};

const TabsContent = React.forwardRef<HTMLDivElement, TabsContentProps>(
  ({ forceMount, ...props }, ref) => (
    <BaseTabs.Panel ref={ref} keepMounted={forceMount} {...props} />
  )
);
TabsContent.displayName = 'TabsContent';

const TabsIndicator = BaseTabs.Indicator;

const Tabs = {
  Root: TabsRoot,
  List: TabsList,
  Trigger: TabsTrigger,
  Content: TabsContent,
  Indicator: TabsIndicator,
};

export {
  Tabs,
  TabsContent,
  TabsIndicator,
  TabsList,
  TabsRoot,
  TabsTrigger,
};
