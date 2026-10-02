// ported-from: packages/shared/src/utils/actionTabTimestamp.ts @ 762abb777
import type { ActionTabEntry } from '../state/atoms';

type DateInput = Date | number | string;

const normalizeDateInput = (value: DateInput): Date | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return null;
    }
    return new Date(value);
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed);
  }

  return null;
};

let customNow: Date | null = null;

const getActionTabNow = (): Date => customNow ?? new Date();

export const setActionTabTimestampNow = (value: DateInput): void => {
  const normalized = normalizeDateInput(value);
  if (normalized) {
    customNow = normalized;
  }
};

export const resetActionTabTimestampNow = (): void => {
  customNow = null;
};

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit'
});

const weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: 'short' });

const monthDayFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric'
});

const monthDayYearFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric'
});

const startOfDay = (value: Date): Date => new Date(value.getFullYear(), value.getMonth(), value.getDate());

const getDaysBetween = (earlierDate: Date, laterDate: Date): number => {
  const earlier = startOfDay(earlierDate);
  const later = startOfDay(laterDate);

  let count = 0;
  const current = new Date(earlier);

  while (current < later) {
    count++;
    current.setDate(current.getDate() + 1);
  }

  return count;
};

export const formatActionTabTimestamp = (
  timestamp: string | null,
  now: Date = getActionTabNow()
): string | null => {
  if (!timestamp) {
    return null;
  }

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  const today = startOfDay(now);
  const candidateDay = startOfDay(parsed);
  const diffDays = candidateDay <= today ? getDaysBetween(candidateDay, today) : 0;
  const boundedDiff = Number.isFinite(diffDays) ? diffDays : 0;

  if (boundedDiff === 0) {
    return `Today ${timeFormatter.format(parsed)}`;
  }

  if (boundedDiff === 1) {
    return `Yesterday ${timeFormatter.format(parsed)}`;
  }

  if (boundedDiff < 7) {
    return `${weekdayFormatter.format(parsed)} ${timeFormatter.format(parsed)}`;
  }

  if (now.getFullYear() === parsed.getFullYear()) {
    return `${monthDayFormatter.format(parsed)} ${timeFormatter.format(parsed)}`;
  }

  return `${monthDayYearFormatter.format(parsed)} ${timeFormatter.format(parsed)}`;
};

export const deriveSubmittedLabel = (
  status: ActionTabEntry['status'],
  createdAt: string | null,
  now: Date = getActionTabNow()
): string | null => {
  if (status === 'draft') {
    return null;
  }

  return formatActionTabTimestamp(createdAt, now);
};
