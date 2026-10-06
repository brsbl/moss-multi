// The roles module (A§8) as properties over its whole domain: the effective role is the MAX of every source, a link
// is a ceiling (its own role for a signed-in caller, viewer at most for an anonymous one), and an unknown role gets
// no capability. Grant lists up to 3 long are enumerated exhaustively; longer folder chains are sampled.
import { describe, expect, it } from 'vitest';
import { CAPABILITY_FLOORS, can, foldRole, MEMBER_ROLES, ROLES, type Capability, type Role, type RoleSources } from './roles.ts';

const rank = (role: Role | null): number => (role === null ? -1 : ROLES.indexOf(role));
const highest = (roles: (Role | null)[]): Role | null => roles.reduce<Role | null>((a, b) => (rank(b) > rank(a) ? b : a), null);

/** A grant or link slot: absent, or any role a row can store. */
const SLOT: (Role | null)[] = [null, ...MEMBER_ROLES];

function* lists(length: number): Generator<(Role | null)[]> {
  if (length === 0) {
    yield [];
    return;
  }
  for (const head of SLOT) for (const tail of lists(length - 1)) yield [head, ...tail];
}

/** Every source combination with up to 3 grants, signed in and anonymous. */
function* everySource(): Generator<RoleSources> {
  for (const owner of [false, true]) {
    for (const anonymous of [false, true]) {
      for (const link of SLOT) {
        for (let length = 0; length <= 3; length += 1) {
          for (const grants of lists(length)) yield { owner, grants, link, anonymous };
        }
      }
    }
  }
}

/** Deterministic samples with folder chains up to the 11-level cap (a doc grant plus each ancestor). */
function* sampledChains(count: number): Generator<RoleSources> {
  let seed = 0x2f6b1a3d;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed % n;
  };
  for (let i = 0; i < count; i += 1) {
    const grants = Array.from({ length: 4 + next(9) }, () => SLOT[next(SLOT.length)]);
    yield { owner: next(4) === 0, grants, link: SLOT[next(SLOT.length)], anonymous: false };
  }
}

const describeSources = (s: RoleSources) => JSON.stringify(s);

describe('foldRole: the MAX fold', () => {
  it('is the highest of ownership, every grant and the link for a signed-in caller', () => {
    for (const sources of [...everySource(), ...sampledChains(2_000)]) {
      if (sources.anonymous) continue;
      const expected = highest([sources.owner ? 'owner' : null, ...sources.grants, sources.link]);
      expect(foldRole(sources), describeSources(sources)).toBe(expected);
    }
  });

  it('does not depend on the order of the grants', () => {
    for (const sources of [...everySource(), ...sampledChains(500)]) {
      const reversed = { ...sources, grants: [...sources.grants].reverse() };
      const rotated = { ...sources, grants: [...sources.grants.slice(1), ...sources.grants.slice(0, 1)] };
      expect(foldRole(reversed), describeSources(sources)).toBe(foldRole(sources));
      expect(foldRole(rotated), describeSources(sources)).toBe(foldRole(sources));
    }
  });

  it('never lowers the role when a source is added', () => {
    for (const sources of everySource()) {
      for (const extra of SLOT) {
        const more = { ...sources, grants: [...sources.grants, extra] };
        expect(rank(foldRole(more)), `${describeSources(sources)} + ${extra}`).toBeGreaterThanOrEqual(rank(foldRole(sources)));
      }
    }
  });

  it('gives no access when no source grants any', () => {
    for (const anonymous of [false, true]) {
      for (const grants of [[], [null], [null, null, null]]) {
        expect(foldRole({ owner: false, grants, link: null, anonymous })).toBeNull();
      }
    }
  });
});

describe('foldRole: the link ceiling', () => {
  it('caps an anonymous caller at viewer: any live link opens the doc read-only, and nothing else opens it', () => {
    for (const sources of everySource()) {
      if (!sources.anonymous) continue;
      expect(foldRole(sources), describeSources(sources)).toBe(sources.link === null ? null : 'viewer');
    }
  });

  it('gives an editor link viewer signed out, editor signed in, and the max with a grant (j08)', () => {
    expect(foldRole({ owner: false, grants: [], link: 'editor', anonymous: true })).toBe('viewer');
    expect(foldRole({ owner: false, grants: [], link: 'editor', anonymous: false })).toBe('editor');
    expect(foldRole({ owner: false, grants: ['commenter'], link: 'editor', anonymous: false })).toBe('editor');
    expect(foldRole({ owner: false, grants: ['editor'], link: 'viewer', anonymous: false })).toBe('editor');
  });
});

describe('foldRole: owner access needs a person (T2.4s)', () => {
  it('never takes owner from a link, even a row that says owner', () => {
    for (const sources of everySource()) {
      const withOwnerLink = { ...sources, link: 'owner' as const };
      const expected = sources.anonymous ? 'viewer' : highest([sources.owner ? 'owner' : null, ...sources.grants, 'editor']);
      expect(foldRole(withOwnerLink), describeSources(withOwnerLink)).toBe(expected);
    }
  });

  it('caps an agent at editor whatever its owner, its grants or a link hold', () => {
    for (const sources of everySource()) {
      for (const extra of [[], ['owner' as const]]) {
        const agent = { ...sources, grants: [...sources.grants, ...extra], agent: true };
        const person = foldRole({ ...agent, agent: false });
        expect(foldRole(agent), describeSources(agent)).toBe(person === 'owner' ? 'editor' : person);
      }
    }
  });
});

describe('can', () => {
  const capabilities = Object.keys(CAPABILITY_FLOORS) as Capability[];

  it('opens each capability at its A§8 floor and above, and nowhere below', () => {
    expect(CAPABILITY_FLOORS).toEqual({ view: 'viewer', comment: 'commenter', suggest: 'suggester', edit: 'editor', manage: 'owner' });
    for (const capability of capabilities) {
      for (const role of ROLES) {
        expect(can(role, capability), `${role} ${capability}`).toBe(rank(role) >= rank(CAPABILITY_FLOORS[capability]));
      }
    }
  });

  it('gives an unknown or missing role no capability', () => {
    for (const role of [null, undefined, '', 'admin', 'Owner', 'EDITOR', 'owner ', 3, {}, ['owner']]) {
      for (const capability of capabilities) expect(can(role, capability), `${JSON.stringify(role)} ${capability}`).toBe(false);
    }
  });
});
