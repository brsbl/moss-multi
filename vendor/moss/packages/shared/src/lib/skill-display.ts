// ported-from: packages/shared/src/lib/skill-display.ts @ 762abb777
/**
 * Map of Claude SDK tool names to human-readable display names
 */
export const SKILL_DISPLAY_NAMES: Record<string, string> = {
  Read: 'Reading',
  Write: 'Writing',
  Edit: 'Editing',
  Bash: 'Running',
  Glob: 'Finding',
  Grep: 'Searching',
  WebFetch: 'Fetching',
  WebSearch: 'Searching Web',
  TodoWrite: 'Planning',
  Task: 'Delegating',
};

/**
 * Map of Claude SDK tool names to their categories for grouping
 */
export const SKILL_CATEGORIES: Record<string, string> = {
  Read: 'Reading',
  Write: 'Writing',
  Edit: 'Editing',
  Bash: 'Running',
  Glob: 'Finding',
  Grep: 'Searching',
  WebFetch: 'Fetching',
  WebSearch: 'Searching',
  TodoWrite: 'Planning',
  Task: 'Delegating',
};

/**
 * Get a human-readable display name for a tool/skill
 * @param skill - The tool name from Claude SDK
 * @returns Human-readable name or the original skill name if not mapped
 */
export function getSkillDisplayName(skill: string): string {
  return SKILL_DISPLAY_NAMES[skill] ?? skill;
}

/**
 * Get the category for a tool/skill (used for grouping multiple tools)
 * @param skill - The tool name from Claude SDK
 * @returns Category name for grouping
 */
export function getSkillCategory(skill: string): string {
  return SKILL_CATEGORIES[skill] ?? skill;
}
