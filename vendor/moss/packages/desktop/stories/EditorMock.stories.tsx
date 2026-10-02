// ported-from: packages/desktop/stories/EditorMock.stories.tsx @ 762abb777
import type { Story } from '@ladle/react';
import { EditorMock } from '../../web/src/components/EditorMock';

export const meta = {
  title: 'Web/EditorMock',
};

/** Full editor mock as it appears in the landing page hero */
export const Default: Story = () => (
  <div className="mx-auto max-w-5xl p-8">
    <EditorMock />
  </div>
);
