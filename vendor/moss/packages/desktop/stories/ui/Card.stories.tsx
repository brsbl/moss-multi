// ported-from: packages/desktop/stories/ui/Card.stories.tsx @ 762abb777
import type { Story } from '@ladle/react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter
} from '@moss/shared/components/ui/card';
import { Button } from '@moss/shared/components/ui/button';

export const meta = {
  title: 'UI/Card'
};

/** Basic card with all sub-components */
export const Complete: Story = () => (
  <div className="p-8">
    <Card className="w-96">
      <CardHeader>
        <CardTitle>Card Title</CardTitle>
        <CardDescription>
          This is a description of what this card contains.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-ink-default">
          Card content goes here. This can include any content like text,
          images, or other components.
        </p>
      </CardContent>
      <CardFooter className="gap-2">
        <Button variant="ghost" size="sm">Cancel</Button>
        <Button size="sm">Save</Button>
      </CardFooter>
    </Card>
  </div>
);

/** Minimal card - just content */
export const Minimal: Story = () => (
  <div className="p-8">
    <Card className="w-96 p-6">
      <p className="text-sm text-ink-default">
        A simple card with just content, no header or footer.
      </p>
    </Card>
  </div>
);

/** Card grid layout */
export const Grid: Story = () => (
  <div className="grid grid-cols-3 gap-4 p-8">
    {['Notes', 'Tasks', 'Settings'].map((title) => (
      <Card key={title} className="p-4">
        <CardHeader className="p-0 pb-2">
          <CardTitle className="text-base">{title}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <p className="text-sm text-ink-muted">
            Click to manage your {title.toLowerCase()}.
          </p>
        </CardContent>
      </Card>
    ))}
  </div>
);

/** Interactive card (hover state) */
export const Interactive: Story = () => (
  <div className="p-8">
    <Card className="w-96 cursor-pointer transition-shadow hover:shadow-md">
      <CardHeader>
        <CardTitle>Clickable Card</CardTitle>
        <CardDescription>Hover to see the shadow effect</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-ink-muted">
          Cards can be made interactive with hover states.
        </p>
      </CardContent>
    </Card>
  </div>
);
