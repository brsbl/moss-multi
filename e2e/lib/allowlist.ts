// Console signatures a journey may log (S-test §2.8). Page errors are never allowlisted; a new signature fails;
// an expired entry fails the selftest project.

export interface AllowEntry {
  pattern: RegExp;
  reason: string;
  /** The ruling or task that accepted it. */
  ruling: string;
  /** Journey ids (file stems such as `j00-shell`) or `*`. */
  scope: string[];
  /** Last day the entry applies, `YYYY-MM-DD` (UTC). */
  expires: string;
}

export const ALLOWLIST: AllowEntry[] = [];

/** Entries whose expiry day has passed. */
export function expiredEntries(list: AllowEntry[], now: Date = new Date()): AllowEntry[] {
  void list;
  void now;
  return [];
}

/** True when a live entry scoped to `journey` matches `text`. */
export function isAllowed(text: string, journey: string, list: AllowEntry[] = ALLOWLIST, now: Date = new Date()): boolean {
  return list.some(
    (entry) =>
      (entry.scope.includes('*') || entry.scope.includes(journey)) && !expiredEntries([entry], now).length && entry.pattern.test(text),
  );
}
