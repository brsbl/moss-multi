// ported-from: packages/desktop/stories/ui/Tooltip.stories.tsx @ 762abb777
import type { Story } from '@ladle/react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@moss/shared/components/ui/tooltip';
import { Button } from '@moss/shared/components/ui/button';
import { HelpCircle, Info, Settings } from 'lucide-react';

export const meta = {
  title: 'UI/Tooltip'
};

/** Basic tooltip on a button */
export const Basic: Story = () => (
  <TooltipProvider>
    <div className="flex items-center justify-center p-16">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline">Hover me</Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>This is a tooltip</p>
        </TooltipContent>
      </Tooltip>
    </div>
  </TooltipProvider>
);

/** Tooltip on an icon button */
export const OnIconButton: Story = () => (
  <TooltipProvider>
    <div className="flex items-center justify-center gap-4 p-16">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon">
            <HelpCircle className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>Get help</p>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon">
            <Settings className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>Open settings</p>
        </TooltipContent>
      </Tooltip>
    </div>
  </TooltipProvider>
);

/** Tooltip positions */
export const Positions: Story = () => (
  <TooltipProvider>
    <div className="flex items-center justify-center gap-8 p-24">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm">Top</Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>Tooltip on top</p>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm">Right</Button>
        </TooltipTrigger>
        <TooltipContent side="right">
          <p>Tooltip on right</p>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm">Bottom</Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>Tooltip on bottom</p>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm">Left</Button>
        </TooltipTrigger>
        <TooltipContent side="left">
          <p>Tooltip on left</p>
        </TooltipContent>
      </Tooltip>
    </div>
  </TooltipProvider>
);

/** Tooltip with longer content */
export const LongContent: Story = () => (
  <TooltipProvider>
    <div className="flex items-center justify-center p-16">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-help items-center gap-1 text-sm text-ink-muted">
            <Info className="h-4 w-4" />
            What is this?
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p>
            This tooltip contains longer explanatory text that wraps to
            multiple lines when needed.
          </p>
        </TooltipContent>
      </Tooltip>
    </div>
  </TooltipProvider>
);
