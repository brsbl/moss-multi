// ported-from: packages/shared/src/components/ui/tooltip.tsx @ 762abb777
import {
  Tooltip as PrimitiveTooltip,
  TooltipCollisionBoundaryProvider as PrimitiveTooltipCollisionBoundaryProvider,
  TooltipContent as PrimitiveTooltipContent,
  TooltipProvider as PrimitiveTooltipProvider,
  TooltipTrigger as PrimitiveTooltipTrigger,
} from '@/components/primitives';

const TooltipProvider = PrimitiveTooltipProvider;
const Tooltip = PrimitiveTooltip;
const TooltipCollisionBoundaryProvider = PrimitiveTooltipCollisionBoundaryProvider;
const TooltipTrigger = PrimitiveTooltipTrigger;
const TooltipContent = PrimitiveTooltipContent;

TooltipTrigger.displayName = PrimitiveTooltipTrigger.displayName;
TooltipContent.displayName = PrimitiveTooltipContent.displayName;

export { Tooltip, TooltipCollisionBoundaryProvider, TooltipTrigger, TooltipContent, TooltipProvider };
