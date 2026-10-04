// ported-from: packages/desktop/stories/editor/SlashCommandMenu.stories.tsx @ 762abb777
import type { Story } from '@ladle/react';
import { DEFAULT_SLASH_COMMANDS } from '../../src/renderer/editor/slash-commands';
import { CATEGORY_LABELS, CATEGORY_ORDER } from '../../src/renderer/editor/slash-commands/types';

export default {
  title: 'Editor/Slash Command Menu'
};

export const CommandCatalog: Story = () => (
  <div className="p-4 space-y-6 max-w-md">
    {CATEGORY_ORDER.map(category => {
      const commands = DEFAULT_SLASH_COMMANDS.filter(c => c.category === category);
      if (commands.length === 0) return null;

      return (
        <div key={category}>
          <h3 className="text-xs font-medium text-ink-muted uppercase tracking-wide mb-2">
            {CATEGORY_LABELS[category]}
          </h3>
          <div className="space-y-1">
            {commands.map(cmd => (
              <div
                key={cmd.id}
                className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-canvas hover:bg-surface-panel transition-colors"
              >
                <div className="flex items-center justify-center w-8 h-8 rounded border border-border-subtle bg-ink-inverse">
                  <cmd.icon className="w-4 h-4 text-ink-muted" />
                </div>
                <div className="flex-1">
                  <span className="text-sm font-medium text-ink-default">{cmd.label}</span>
                  {cmd.description && (
                    <p className="text-xs text-ink-muted">{cmd.description}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    })}
  </div>
);
