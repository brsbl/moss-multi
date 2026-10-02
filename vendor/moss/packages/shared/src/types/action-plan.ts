// ported-from: packages/shared/src/types/action-plan.ts @ 762abb777
export type ActionPlanTodo = {
  id: string;
  text: string;
  completed: boolean;
};

export type ActionPlanNoteChange = {
  type: 'note_updated' | 'note_created';
  noteTitle?: string;
  description?: string;
};

export type ActionPlanFileChange = {
  type: 'created' | 'modified' | 'deleted';
  path: string;
  additions?: number;
  deletions?: number;
};

export type ActionPlanChange = ActionPlanNoteChange | ActionPlanFileChange;
