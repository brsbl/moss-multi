---
tags:
  - Ladle
  - visual testing
  - component stories
  - design tokens
  - UI primitives
projects:
  - Moss
frameworks:
  - Ladle
  - React
tools:
  - pnpm
---
# Story Strategy

This document defines the principles for creating and maintaining Ladle stories in the Moss codebase.

## Core Principle

**Stories test visual contracts, not features.**

Stories answer: *"Does this component look right in all its states?"*

They are NOT for:
- Testing business logic (use unit tests)
- Testing user flows (use E2E tests)
- Testing the full app (too fragile, too slow)

## The Story Pyramid

```
                    ┌─────────────┐
                    │   Layouts   │  ← 1-2 stories max (App shell, empty state)
                    ├─────────────┤
                    │  Composite  │  ← Key configurations only
                    │  Components │     (ActionsPanel, NotesListPanel)
                    ├─────────────┤
                    │  UI         │  ← All meaningful states
                    │  Primitives │     (ActionTimelineCard, DraggableModal)
                    ├─────────────┤
                    │   Design    │  ← Reference documentation
                    │   Tokens    │     (Colors, Typography, Spacing)
                    └─────────────┘
```

More stories at the bottom, fewer at the top.

## When to Create Stories

| Scenario | Example | Why |
|----------|---------|-----|
| Each visual state of a primitive | `ActionTimelineCard`: Collapsed, Expanded, Completed confirmation, Interrupted, Error, Pending (streaming) | These are the component's visual API |
| Edge cases that affect layout | Many file changes, long prompts, empty content | Catches overflow, truncation, wrapping bugs |
| Design tokens | Colors, Typography, Widths | Living documentation for designers + devs |
| Interactive behavior that's hard to test otherwise | Typeahead menus, formula pills | Need visual context to verify |

## When NOT to Create Stories

| Scenario | Example | Why |
|----------|---------|-----|
| Full app compositions | `<App />` with different data | Too brittle, duplicates E2E tests |
| Minor prop variations | Button with different `onClick` handlers | No visual difference |
| Wrapper components that just pass props | Layout shells with no visual logic | Test what they wrap instead |
| Internal components not meant for reuse | One-off pieces inside a feature | Churn too fast, low value |
| Components not used in the app | Legacy/deprecated components | Dead code shouldn't have stories |

## Directory Structure

```
stories/
├── STORIES.md                       # This file
├── utils/
│   └── story-data.tsx               # Shared test data and providers
├── DesignSystem.stories.tsx         # Tokens only: Colors, Typography, Spacing
├── App.stories.tsx                  # 1-2 smoke tests for the full app
├── DraggableModal.stories.tsx       # Reusable modal primitive
├── ActionsPanel.stories.tsx         # Action panel configurations
├── ActionTimelineCard.stories.tsx   # Timeline card states
├── panels/
│   └── NotesListPanel.stories.tsx   # Notes list configurations
└── editor/
    ├── PillNodes.stories.tsx        # Formula, FileLink, broken links
    └── TypeaheadMenus.stories.tsx   # Slash commands, [[, =
```

## Principles

### 1. One Component = One Story File

Don't mix component demos into `DesignSystem.stories.tsx`. Each component owns its visual contract in its own file.

```tsx
// ✅ Good: ActionTimelineCard.stories.tsx
export const Collapsed: Story = () => <ActionTimelineCard ... />;
export const Expanded: Story = () => <ActionTimelineCard ... />;

// ❌ Bad: DesignSystem.stories.tsx
export const ActionCards: Story = () => <ActionTimelineCard ... />;
```

### 2. States Over Scenarios

Name stories by visual state, not user journey.

```tsx
// ✅ Good
export const ErrorState: Story = () => ...
export const PendingState: Story = () => ...
export const Collapsed: Story = () => ...

// ❌ Bad
export const UserClicksButtonThenSeesError: Story = () => ...
```

### 3. Delete Redundant Compositions

If two story files render the same component with similar data, keep one.

### 4. Design Tokens Are Documentation

`DesignSystem.stories.tsx` is a reference guide, not a test suite. It should contain:
- Color swatches
- Typography samples
- Spacing scale
- Shadow examples
- Border radius

It should NOT contain component demos.

### 5. Interactive Stories Need Controlled State

Use `useState` to make expand/collapse, toggles, and selections work in Ladle.

```tsx
// ✅ Good: Interactive
export const Collapsed: Story = () => {
  const [isExpanded, setIsExpanded] = useState(false);
  return <Card isExpanded={isExpanded} onToggle={() => setIsExpanded(!isExpanded)} />;
};

// ❌ Bad: Static (can't interact)
export const Collapsed: Story = () => <Card isExpanded={false} onToggle={() => {}} />;
```

### 6. Prune Aggressively

- If a component isn't used in the app, delete its story
- If two stories look identical, keep one
- If a story tests behavior (not appearance), move it to a unit test

## Story Checklist

Before adding a new story, ask:

1. Is this component used in the app? (If no, don't create a story)
2. Does this story show a distinct visual state? (If no, consolidate)
3. Is the story file in the right location per the pyramid? (Primitive vs composite vs layout)
4. Does the story use controlled state for interactivity?
5. Is the story named after a state, not a scenario?

## Running Stories

```bash
# Start Ladle dev server
npx ladle serve

# Or use pnpm
pnpm --filter @moss/desktop ladle serve
```

Stories are available at http://localhost:61000/
