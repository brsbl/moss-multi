The plan for opening the multiplayer beta: who owns each step, when it lands, and the numbers we watch. Everyone edits this note together.

```moss-callout
info
Invites go out in two waves. Questions go in a comment on the line they are about.
```

## Why it matters

When three people open the same note at once, each of them should see the others' cursors, comments and suggestions arrive within a heartbeat, so that nobody has to ask who moved the launch date, why the budget changed, or whether the checklist they are reading is the one everyone else is reading too.

| Milestone | Owner | Date |
| --- | --- | --- |
| Private beta | Ada | October 20 |
| Public beta | Ben | November 3 |
| General availability | Ada | December 1 |

```moss-chart
{"type":"bar","title":"Weekly active editors","data":[{"label":"W38","value":42},{"label":"W39","value":61},{"label":"W40","value":88},{"label":"W41","value":127}]}
```

## Scope

The beta opens to the first 200 teams on November 3. At five editors a team that is {{200*5|1000}} seats, and the budget is {{budget|$36,000}} for the quarter.

```ts
export const beta = { teams: 200, waves: 2, opensOn: '2026-11-03' };
```

## Checklist

- [x] Pick the first wave of teams
- [ ] Draft the launch announcement
- [ ] Turn on the invite flag for wave one
