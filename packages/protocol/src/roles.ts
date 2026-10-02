// The one roles module (A§8): client affordances and server enforcement both read it. T1.1 adds the capability
// floors and can(); an unknown role gets no actions.

export const ROLES = ['viewer', 'commenter', 'suggester', 'editor', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export const isRole = (value: unknown): value is Role => typeof value === 'string' && (ROLES as readonly string[]).includes(value);

/** False for an unknown role on either side. */
export function roleAtLeast(role: unknown, floor: Role): boolean {
  return isRole(role) && ROLES.indexOf(role) >= ROLES.indexOf(floor);
}
