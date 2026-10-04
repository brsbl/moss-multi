// ported-from: packages/shared/src/mocks/action-timeline-mock-data.ts @ 762abb777
/**
 * Mock data generators for action timeline todos and changes.
 * TODO: Remove this file when real agent integration is complete (see roadmap.md).
 */

export interface MockTodoItem {
  id: string;
  text: string;
  completed: boolean;
}

export interface MockFileChange {
  type: 'created' | 'modified' | 'deleted';
  path: string;
  additions?: number;
  deletions?: number;
}

export interface MockNoteChange {
  type: 'note_updated' | 'note_created';
  noteTitle: string;
  description: string;
}

export type MockChange = MockFileChange | MockNoteChange;

const todoTemplates = [
  'Read and understand the user request',
  'Analyze the current note structure',
  'Identify files that need to be modified',
  'Apply the requested changes',
  'Update file system as needed',
  'Verify changes are correct',
  'Test the implementation',
  'Format code according to style guide',
  'Add documentation comments',
  'Create backup checkpoint',
  'Review security implications',
  'Optimize performance',
  'Handle edge cases',
  'Add error handling',
  'Update related files'
];

const fileChangeTemplates = [
  { path: 'src/components/Button.tsx', type: 'modified' as const },
  { path: 'src/utils/helpers.ts', type: 'modified' as const },
  { path: 'src/types/index.ts', type: 'created' as const },
  { path: 'package.json', type: 'modified' as const },
  { path: 'README.md', type: 'modified' as const },
  { path: 'src/config.ts', type: 'created' as const },
  { path: 'tests/unit.test.ts', type: 'modified' as const },
  { path: '.gitignore', type: 'modified' as const },
  { path: 'src/legacy/old-component.tsx', type: 'deleted' as const }
];

const noteChangeDescriptions = [
  'Added implementation details',
  'Updated code examples',
  'Refactored component structure',
  'Added error handling',
  'Improved documentation',
  'Fixed typos and formatting',
  'Added new section on best practices'
];

const todoCountSequence = [3, 4, 5, 4];
const completedRatioSequence = [0.4, 0.6, 0.75, 0.5];
const fileCountSequence = [1, 2, 3, 2, 4];
const additionSequence = [6, 14, 22, 10, 18, 26];
const deletionSequence = [0, 2, 4, 1, 3, 5];

let todoTemplateCursor = 0;
let todoCountCursor = 0;
let completedRatioCursor = 0;
let todoIdCounter = 0;
let noteDescriptionCursor = 0;
let fileTemplateCursor = 0;
let fileCountCursor = 0;
let additionCursor = 0;
let deletionCursor = 0;

const takeSequentialSlice = <T>(items: readonly T[], startIndex: number, length: number): T[] => {
  const output: T[] = [];
  for (let i = 0; i < length; i += 1) {
    const index = (startIndex + i) % items.length;
    output.push(items[index]);
  }
  return output;
};

const pullNextTodoCount = () => {
  const value = todoCountSequence[todoCountCursor];
  todoCountCursor = (todoCountCursor + 1) % todoCountSequence.length;
  return value;
};

const pullNextCompletedRatio = () => {
  const value = completedRatioSequence[completedRatioCursor];
  completedRatioCursor = (completedRatioCursor + 1) % completedRatioSequence.length;
  return value;
};

const pullNextFileCount = () => {
  const value = fileCountSequence[fileCountCursor];
  fileCountCursor = (fileCountCursor + 1) % fileCountSequence.length;
  return value;
};

/**
 * Generate a deterministic set of mock todos for the plan section.
 * @param count Number of todos to generate (defaults to sequential pattern)
 * @param completedRatio Ratio of completed todos (0-1, defaults to sequential pattern)
 */
export function generateMockTodos(
  count?: number,
  completedRatio?: number
): MockTodoItem[] {
  const resolvedCount = count ?? pullNextTodoCount();
  const resolvedRatio = completedRatio ?? pullNextCompletedRatio();

  const selectedTemplates = takeSequentialSlice(todoTemplates, todoTemplateCursor, resolvedCount);
  todoTemplateCursor = (todoTemplateCursor + resolvedCount) % todoTemplates.length;

  const safeRatio = Math.min(1, Math.max(0, resolvedRatio));
  const completedCount = Math.floor(resolvedCount * safeRatio);

  return selectedTemplates.map((text, index) => ({
    id: `todo-${todoIdCounter++}`,
    text,
    completed: index < completedCount
  }));
}

const nextAddition = () => {
  const value = additionSequence[additionCursor];
  additionCursor = (additionCursor + 1) % additionSequence.length;
  return value;
};

const nextDeletion = () => {
  const value = deletionSequence[deletionCursor];
  deletionCursor = (deletionCursor + 1) % deletionSequence.length;
  return value;
};

/**
 * Generate a deterministic set of mock changes for the changes made section.
 * @param includeFileChanges Whether to include file changes (default: true)
 * @param includeNoteChange Whether to include note update (default: true)
 */
export function generateMockChanges(
  includeFileChanges = true,
  includeNoteChange = true
): MockChange[] {
  const changes: MockChange[] = [];

  if (includeNoteChange) {
    const description = noteChangeDescriptions[noteDescriptionCursor];
    noteDescriptionCursor = (noteDescriptionCursor + 1) % noteChangeDescriptions.length;
    changes.push({
      type: 'note_updated',
      noteTitle: 'Untitled',
      description
    });
  }

  if (includeFileChanges) {
    const fileCount = pullNextFileCount();

    const selectedTemplates = takeSequentialSlice(fileChangeTemplates, fileTemplateCursor, fileCount);
    fileTemplateCursor = (fileTemplateCursor + fileCount) % fileChangeTemplates.length;

    for (const template of selectedTemplates) {
      const change: MockFileChange = { ...template };
      if (template.type === 'modified') {
        change.additions = nextAddition();
        change.deletions = nextDeletion();
      }
      changes.push(change);
    }
  }

  return changes;
}
