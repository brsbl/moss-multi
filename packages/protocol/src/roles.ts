// The one roles module (A§8): client affordances and server enforcement both read it, and an unknown role gets no
// actions.

export const ROLES = ['viewer', 'commenter', 'suggester', 'editor', 'owner'] as const;
export type Role = (typeof ROLES)[number];

/** Roles a share-link row stores: a link never confers ownership (A§6). */
export const MEMBER_ROLES = ['viewer', 'commenter', 'suggester', 'editor'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** Roles a grant or invite row stores. The vault owner is never stored; an `owner` grant makes a co-owner (P:People). */
export const GRANT_ROLES = ROLES;

/** What the share UI offers a person until suggestions ship (P:People); suggester stays in the schema only. */
export const SHARE_ROLES = ['viewer', 'commenter', 'editor', 'owner'] as const;
export type ShareRole = (typeof SHARE_ROLES)[number];

/** What the share UI offers a link: up to editor, and anonymous visitors read at viewer whatever it says. */
export const LINK_ROLES = ['viewer', 'commenter', 'editor'] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

export const isRole = (value: unknown): value is Role => typeof value === 'string' && (ROLES as readonly string[]).includes(value);

/** False for an unknown role on either side. */
export function roleAtLeast(role: unknown, floor: Role): boolean {
  return isRole(role) && ROLES.indexOf(role) >= ROLES.indexOf(floor);
}

/** The least role each capability needs (A§8). */
export const CAPABILITY_FLOORS = {
  view: 'viewer',
  comment: 'commenter',
  suggest: 'suggester',
  edit: 'editor',
  manage: 'owner',
} as const satisfies Record<string, Role>;
export type Capability = keyof typeof CAPABILITY_FLOORS;

/** Whether `role` clears the capability's floor; null and unknown roles clear none. */
export function can(role: unknown, capability: Capability): boolean {
  return roleAtLeast(role, CAPABILITY_FLOORS[capability]);
}

export function maxRole(a: Role | null, b: Role | null): Role | null {
  if (a === null) return b;
  if (b === null) return a;
  return ROLES.indexOf(a) >= ROLES.indexOf(b) ? a : b;
}

/** Every source of one principal's role on one doc. */
export interface RoleSources {
  /** The acting user owns the doc's vault. */
  owner: boolean;
  /** The doc grant and every folder-chain grant up to the vault, each null when absent. */
  grants: readonly (Role | null)[];
  /** The role of a live share link that covers the doc, or null. */
  link: Role | null;
  /** No signed-in identity: a share token alone. */
  anonymous: boolean;
}

/**
 * The effective role (A§8): the MAX of ownership, the grants and the link. The link is a ceiling: it lifts a
 * signed-in caller to its role and no further, and an anonymous caller to viewer at most.
 */
export function foldRole({ owner, grants, link, anonymous }: RoleSources): Role | null {
  if (anonymous) return link === null ? null : 'viewer';
  let role: Role | null = owner ? 'owner' : null;
  for (const grant of grants) role = maxRole(role, grant);
  return maxRole(role, link);
}
