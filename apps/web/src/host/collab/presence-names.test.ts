// Names the roster and the remote carets show (T9.32): full names, a window suffix for one person in several
// windows, a stable ordinal for different people who share a full name; never an internal id.
import { expect, it } from 'vitest';
import { sessionLabels, visitMemory, type Session } from './presence-names.ts';

const s = (clientId: number, principalId: string, name: string): Session => ({ clientId, principalId, name });

it('distinct names are shown as they are', () => {
  const labels = sessionLabels([s(1, 'p-ada', 'Ada Lovelace'), s(2, 'p-ann', 'Ann Lee'), s(3, 'p-ben', 'Ben Ode')], visitMemory());
  expect([...labels.values()]).toEqual(['Ada Lovelace', 'Ann Lee', 'Ben Ode']);
});

it('one person in two windows gets a window suffix on each session, never merged', () => {
  const labels = sessionLabels([s(1, 'p-ada', 'Ada'), s(2, 'p-ben', 'Ben'), s(3, 'p-ben', 'Ben')], visitMemory());
  expect(labels.get(1)).toBe('Ada');
  expect(labels.get(2)).toBe('Ben · window 1');
  expect(labels.get(3)).toBe('Ben · window 2');
});

it('different people with the same full name get an ordinal that is stable for the visit', () => {
  const memory = visitMemory();
  const first = sessionLabels([s(1, 'p-sam-a', 'Sam Lee'), s(2, 'p-sam-b', 'Sam Lee'), s(3, 'p-sam-c', 'Sam Lee')], memory);
  expect([first.get(1), first.get(2), first.get(3)]).toEqual(['Sam Lee (1)', 'Sam Lee (2)', 'Sam Lee (3)']);
  // The first Sam leaves: the others keep their numbers.
  const later = sessionLabels([s(2, 'p-sam-b', 'Sam Lee'), s(3, 'p-sam-c', 'Sam Lee')], memory);
  expect([later.get(2), later.get(3)]).toEqual(['Sam Lee (2)', 'Sam Lee (3)']);
  // Alone again, a name needs no number.
  expect(sessionLabels([s(3, 'p-sam-c', 'Sam Lee')], memory).get(3)).toBe('Sam Lee');
});

it('labels never carry a principal or client id', () => {
  const labels = sessionLabels([s(41, 'usr_secret', 'Kim'), s(42, 'usr_secret', 'Kim'), s(43, 'usr_other', 'Kim')], visitMemory());
  for (const label of labels.values()) {
    expect(label).not.toMatch(/usr_|41|42|43/);
    expect(label.startsWith('Kim')).toBe(true);
  }
  expect(new Set(labels.values()).size).toBe(3);
});
