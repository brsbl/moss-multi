// ported-from: packages/desktop/stories/ui/DropdownMenu.stories.tsx @ 762abb777
import { useState } from 'react';
import type { Story } from '@ladle/react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem
} from '@moss/shared/components/ui/dropdown-menu';
import { Button } from '@moss/shared/components/ui/button';
import { MoreVertical, Pencil, Copy, Trash2, Download, Share } from 'lucide-react';

export const meta = {
  title: 'UI/DropdownMenu'
};

/** Basic dropdown with text items */
export const Basic: Story = () => (
  <div className="flex items-center justify-center p-16">
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Open Menu</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Profile</DropdownMenuItem>
        <DropdownMenuItem>Settings</DropdownMenuItem>
        <DropdownMenuItem>Help</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
);

/** Dropdown with icons */
export const WithIcons: Story = () => (
  <div className="flex items-center justify-center p-16">
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon">
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>
          <Pencil className="h-4 w-4" />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Copy className="h-4 w-4" />
          Duplicate
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Download className="h-4 w-4" />
          Download
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Share className="h-4 w-4" />
          Share
        </DropdownMenuItem>
        <DropdownMenuItem className="text-status-error-text">
          <Trash2 className="h-4 w-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
);

/** Interactive dropdown with state */
export const Interactive: Story = () => {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-center gap-4 p-16">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary">
            {selected ? `Selected: ${selected}` : 'Choose an option'}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {['Option A', 'Option B', 'Option C'].map((option) => (
            <DropdownMenuItem key={option} onClick={() => setSelected(option)}>
              {option}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {selected && (
        <p className="text-sm text-ink-muted">You selected: {selected}</p>
      )}
    </div>
  );
};

/** Disabled items */
export const WithDisabledItems: Story = () => (
  <div className="flex items-center justify-center p-16">
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Available Action</DropdownMenuItem>
        <DropdownMenuItem disabled>Disabled Action</DropdownMenuItem>
        <DropdownMenuItem>Another Action</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
);
