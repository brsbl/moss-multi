// Oracle-only story (T9.21): pristine moss with one new, empty note open, so e2e/parity/first-click.spec.ts can
// insert a table from the slash menu and click into a body cell. build.mjs copies this file into moss's stories.
import type { Story } from '@ladle/react';
import App from '../src/renderer/App';
import { StoryAppProvider } from './utils/story-data';

const note = { id: 'new-table', title: '', updatedAt: Date.parse('2025-01-09T12:00:00.000Z'), folderPath: 'Notes' };

export const Empty: Story = () => (
  <StoryAppProvider notes={[note]} activeId={note.id}>
    <App />
  </StoryAppProvider>
);
