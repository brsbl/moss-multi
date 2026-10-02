// ported-from: packages/shared/src/components/ui/dropdown-menu.tsx @ 762abb777
import {
  DropdownMenu as PrimitiveDropdownMenu,
  DropdownMenuContent as PrimitiveDropdownMenuContent,
  DropdownMenuItem as PrimitiveDropdownMenuItem,
  DropdownMenuSeparator as PrimitiveDropdownMenuSeparator,
  DropdownMenuTrigger as PrimitiveDropdownMenuTrigger,
} from '@/components/primitives';

const DropdownMenu = PrimitiveDropdownMenu;
const DropdownMenuTrigger = PrimitiveDropdownMenuTrigger;
const DropdownMenuContent = PrimitiveDropdownMenuContent;
const DropdownMenuItem = PrimitiveDropdownMenuItem;
const DropdownMenuSeparator = PrimitiveDropdownMenuSeparator;

DropdownMenuTrigger.displayName = PrimitiveDropdownMenuTrigger.displayName;
DropdownMenuContent.displayName = PrimitiveDropdownMenuContent.displayName;
DropdownMenuItem.displayName = PrimitiveDropdownMenuItem.displayName;
DropdownMenuSeparator.displayName = PrimitiveDropdownMenuSeparator.displayName;

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
};

export {
  DropdownMenuArrow,
  DropdownMenuCheckboxItem,
  DropdownMenuCheckboxItemIndicator,
  DropdownMenuGroup,
  DropdownMenuItemIndicator,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRadioItemIndicator,
  DropdownMenuRoot,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuViewport,
} from '@/components/primitives';
