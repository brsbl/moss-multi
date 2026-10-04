// ported-from: packages/shared/src/components/ui/context-menu.tsx @ 762abb777
import {
  ContextMenu as PrimitiveContextMenu,
  ContextMenuContent as PrimitiveContextMenuContent,
  ContextMenuItem as PrimitiveContextMenuItem,
  ContextMenuLabel as PrimitiveContextMenuLabel,
  ContextMenuSeparator as PrimitiveContextMenuSeparator,
  ContextMenuTrigger as PrimitiveContextMenuTrigger,
} from '@/components/primitives';

const ContextMenu = PrimitiveContextMenu;
const ContextMenuTrigger = PrimitiveContextMenuTrigger;
const ContextMenuContent = PrimitiveContextMenuContent;
const ContextMenuItem = PrimitiveContextMenuItem;
const ContextMenuSeparator = PrimitiveContextMenuSeparator;
const ContextMenuLabel = PrimitiveContextMenuLabel;

ContextMenuTrigger.displayName = PrimitiveContextMenuTrigger.displayName;
ContextMenuContent.displayName = PrimitiveContextMenuContent.displayName;
ContextMenuItem.displayName = PrimitiveContextMenuItem.displayName;
ContextMenuSeparator.displayName = PrimitiveContextMenuSeparator.displayName;
ContextMenuLabel.displayName = PrimitiveContextMenuLabel.displayName;

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuLabel
};

export {
  ContextMenuArrow,
  ContextMenuGroup,
  ContextMenuPortal,
  ContextMenuRoot,
} from '@/components/primitives';
