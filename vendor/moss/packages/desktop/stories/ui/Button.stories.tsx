// ported-from: packages/desktop/stories/ui/Button.stories.tsx @ 762abb777
import type { Story } from '@ladle/react';
import { Button } from '@moss/shared/components/ui/button';
import { Plus, Loader2, Download, Trash2, Square } from 'lucide-react';

export const meta = {
  title: 'UI/Button'
};

/** Default primary button - the main CTA style */
export const Default: Story = () => (
  <div className="flex gap-4 p-8">
    <Button>Default Button</Button>
  </div>
);

/** All button variants side by side */
export const AllVariants: Story = () => (
  <div className="flex flex-wrap gap-4 p-8">
    <Button variant="default">Default</Button>
    <Button variant="secondary">Secondary</Button>
    <Button variant="outline">Outline</Button>
    <Button variant="ghost">Ghost</Button>
    <Button variant="link">Link</Button>
    <Button variant="danger">Danger</Button>
    <Button variant="stop">
      <Square className="mr-2 h-4 w-4 fill-ink-muted" />
      Stop
    </Button>
  </div>
);

/** Size variations */
export const Sizes: Story = () => (
  <div className="flex items-center gap-4 p-8">
    <Button size="sm">Small</Button>
    <Button size="default">Default</Button>
    <Button size="lg">Large</Button>
    <Button size="icon">
      <Plus className="h-4 w-4" />
    </Button>
  </div>
);

/** Buttons with icons */
export const WithIcons: Story = () => (
  <div className="flex flex-wrap gap-4 p-8">
    <Button>
      <Plus className="mr-2 h-4 w-4" />
      Add Item
    </Button>
    <Button variant="secondary">
      <Download className="mr-2 h-4 w-4" />
      Download
    </Button>
    <Button variant="danger">
      <Trash2 className="mr-2 h-4 w-4" />
      Delete
    </Button>
  </div>
);

/** Disabled state */
export const Disabled: Story = () => (
  <div className="flex flex-wrap gap-4 p-8">
    <Button disabled>Disabled Default</Button>
    <Button variant="secondary" disabled>Disabled Secondary</Button>
    <Button variant="outline" disabled>Disabled Outline</Button>
  </div>
);

/** Loading state pattern */
export const Loading: Story = () => (
  <div className="flex gap-4 p-8">
    <Button disabled>
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      Saving...
    </Button>
    <Button variant="secondary" disabled>
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      Loading...
    </Button>
  </div>
);

/** Stop button variant - used to cancel running operations */
export const StopButton: Story = () => (
  <div className="flex flex-col gap-4 p-8">
    <div className="flex gap-4">
      <Button variant="stop" size="sm" className="gap-2">
        <Square className="h-3.5 w-3.5 fill-ink-muted" />
        <span>Stop</span>
      </Button>
    </div>
    <div className="flex gap-4">
      <Button variant="stop">
        <Square className="mr-2 h-4 w-4 fill-ink-muted" />
        Stop Generation
      </Button>
      <Button variant="stop" size="lg">
        <Square className="mr-2 h-5 w-5 fill-ink-muted" />
        Cancel Operation
      </Button>
    </div>
  </div>
);
