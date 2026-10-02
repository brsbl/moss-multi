// ported-from: packages/shared/src/components/ui/streaming-tool-indicator.tsx @ 762abb777
/**
 * StreamingToolIndicator displays active tool executions during agent streaming.
 * Shows an animated indicator with the tool name(s) currently running.
 */

import { useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import { getSkillDisplayName, getSkillCategory } from '../../lib/skill-display';
import type { ActiveToolExecution } from '../../state/atoms';

export interface StreamingToolIndicatorProps {
  /** Active tools currently executing */
  activeTools: ActiveToolExecution[];
  /** Optional CSS class name */
  className?: string;
  /** Whether to show the full tool list or just the most recent */
  showFullList?: boolean;
}

/**
 * Formats tool executions into a human-readable string.
 * Groups by category and shows counts for multiples.
 */
function formatActiveTools(tools: ActiveToolExecution[]): string {
  if (tools.length === 0) {
    return 'Working...';
  }

  if (tools.length === 1) {
    return getSkillDisplayName(tools[0].toolName);
  }

  // Group by category
  const categories = new Map<string, number>();
  for (const tool of tools) {
    const category = getSkillCategory(tool.toolName);
    categories.set(category, (categories.get(category) ?? 0) + 1);
  }

  // Format as "Reading (3), Editing (2)"
  const parts: string[] = [];
  for (const [category, count] of categories) {
    if (count > 1) {
      parts.push(`${category} (${count})`);
    } else {
      parts.push(category);
    }
  }

  return parts.join(', ');
}

/**
 * Displays an animated indicator showing which tools are currently executing.
 * Used in the actions panel to show real-time agent progress.
 */
export function StreamingToolIndicator({
  activeTools,
  className = '',
  showFullList = false
}: StreamingToolIndicatorProps) {
  const displayText = useMemo(() => formatActiveTools(activeTools), [activeTools]);

  // Show individual tools if requested and there are multiple
  const toolList = showFullList && activeTools.length > 1 ? activeTools : null;

  return (
    <div
      className={`flex items-center gap-2 text-sm text-ink-muted ${className}`}
      role="status"
      aria-live="polite"
      aria-label={`Agent is ${displayText.toLowerCase()}`}
    >
      <Loader2
        className="h-4 w-4 animate-spin text-accent-brand"
        aria-hidden="true"
      />
      <span className="truncate">{displayText}</span>

      {toolList && (
        <ul className="sr-only">
          {toolList.map((tool) => (
            <li key={tool.toolId}>
              {getSkillDisplayName(tool.toolName)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Compact version for inline use within action tabs.
 */
export function StreamingToolIndicatorCompact({
  activeTools
}: Pick<StreamingToolIndicatorProps, 'activeTools'>) {
  if (activeTools.length === 0) {
    return (
      <Loader2
        className="h-3 w-3 animate-spin text-accent-brand"
        aria-label="Working"
      />
    );
  }

  const latestTool = activeTools[activeTools.length - 1];
  const displayName = getSkillDisplayName(latestTool.toolName);

  return (
    <span
      className="flex items-center gap-1 text-xs text-ink-muted"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="h-3 w-3 animate-spin text-accent-brand" aria-hidden="true" />
      <span className="truncate max-w-24">{displayName}</span>
    </span>
  );
}
