// The inventory drift test (A§9): the bridge, the inventory and moss's ElectronAPI type agree method for method,
// every hidden entry names a registry id, and a staged entry fails once its milestone has closed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AFFORDANCES } from '../affordances.ts';
import { createBridge } from './index.ts';
import { closedMilestone, expiredStaged, INVENTORY, type InventoryEntry, unlistedMethods } from './inventory.ts';

const API_DTS = fileURLToPath(new URL('../../../../../vendor/moss/packages/desktop/src/types/electron-api.d.ts', import.meta.url));

/** `namespace.method` for every method of every ElectronAPI namespace, and which namespaces are optional. */
function electronApiMethods(source = readFileSync(API_DTS, 'utf8')): { methods: string[]; optional: string[] } {
  const file = ts.createSourceFile('electron-api.d.ts', source, ts.ScriptTarget.Latest, true);
  const interfaces = new Map<string, ts.InterfaceDeclaration>();
  file.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node)) interfaces.set(node.name.text, node);
  });
  const root = interfaces.get('ElectronAPI');
  if (!root) throw new Error('electron-api.d.ts has no ElectronAPI interface');
  const methods: string[] = [];
  const optional: string[] = [];
  for (const member of root.members) {
    if (!ts.isPropertySignature(member) || !member.type || !ts.isTypeReferenceNode(member.type)) continue;
    const namespace = member.name.getText(file);
    if (member.questionToken) optional.push(namespace);
    const api = interfaces.get(member.type.typeName.getText(file));
    if (!api) throw new Error(`ElectronAPI.${namespace}: no interface ${member.type.typeName.getText(file)}`);
    for (const item of api.members) {
      const isMethod = ts.isMethodSignature(item) || (ts.isPropertySignature(item) && item.type && ts.isFunctionTypeNode(item.type));
      if (isMethod && item.name) methods.push(`${namespace}.${item.name.getText(file)}`);
    }
  }
  return { methods, optional };
}

/** `namespace.method` for every function the bridge installs. */
function bridgeMethods(bridge: object): string[] {
  return Object.entries(bridge).flatMap(([namespace, api]) =>
    api && typeof api === 'object'
      ? Object.entries(api as Record<string, unknown>).filter(([, value]) => typeof value === 'function').map(([name]) => `${namespace}.${name}`)
      : [],
  );
}

const bridge = createBridge({ pathname: () => '/', fetch: async () => Response.json({}) });

describe('the bridge inventory', () => {
  const api = electronApiMethods();

  it('reads every ElectronAPI method from moss at the pin', () => {
    expect(api.methods).toContain('notes.getAll');
    expect(api.methods).toContain('settings.getNoteIntelligence');
    expect(api.methods.length).toBeGreaterThan(100);
  });

  it('lists every ElectronAPI method, and nothing moss lacks', () => {
    expect(unlistedMethods(api.methods), 'ElectronAPI methods missing from the inventory').toEqual([]);
    expect(Object.keys(INVENTORY).filter((key) => !api.methods.includes(key)), 'inventory entries moss does not declare').toEqual([]);
  });

  it('matches the installed bridge: every listed method exists, and no stub is unlisted', () => {
    const installed = bridgeMethods(bridge);
    const expected = Object.entries(INVENTORY).filter(([, entry]) => entry.treatment !== 'absent').map(([key]) => key);
    expect(installed.filter((key) => !expected.includes(key)), 'bridge methods the inventory lacks or marks absent').toEqual([]);
    expect(expected.filter((key) => !installed.includes(key)), 'inventory methods the bridge lacks').toEqual([]);
  });

  it('leaves only optional namespaces absent', () => {
    const absent = new Set(Object.entries(INVENTORY).filter(([, e]) => e.treatment === 'absent').map(([key]) => key.split('.')[0]));
    expect([...absent].filter((namespace) => !api.optional.includes(namespace))).toEqual([]);
    for (const namespace of absent) expect((bridge as Record<string, unknown>)[namespace], namespace).toBeUndefined();
  });

  it('names a hide-registry id for every hidden entry, and a milestone for every staged one', () => {
    const ids = new Set<string>(AFFORDANCES.map((entry) => entry.id));
    const routings = Object.entries(INVENTORY).flatMap(([key, entry]) => [
      [key, entry] as const,
      ...Object.entries(entry.fields ?? {}).map(([field, routing]) => [`${key}#${field}`, routing] as const),
    ]);
    for (const [key, entry] of Object.entries(INVENTORY)) {
      if (entry.treatment === 'hidden') expect(entry.affordance && ids.has(entry.affordance), `${key}: hidden by a registry id`).toBe(true);
      if (entry.affordance) expect(ids.has(entry.affordance), `${key}: ${entry.affordance} is registered`).toBe(true);
    }
    for (const [key, routing] of routings) {
      if (routing.treatment === 'staged') expect(Number.isInteger(routing.milestone), `${key}: staged to a milestone`).toBe(true);
      expect(routing.note.length, `${key}: says what the web does`).toBeGreaterThan(0);
    }
  });

  it('fails on an ElectronAPI method the inventory lacks (negative control)', () => {
    const grown = electronApiMethods(readFileSync(API_DTS, 'utf8').replace('getAll(): Promise<NoteMetadataRecord[]>;', 'getAll(): Promise<NoteMetadataRecord[]>;\n  fooBar(): Promise<void>;'));
    expect(unlistedMethods(grown.methods, { 'notes.getAll': { treatment: 'real', note: 'listing' } })).toContain('notes.fooBar');
    expect(unlistedMethods(grown.methods)).toEqual(['notes.fooBar']);
  });

  it('fails on a staged entry once its milestone has closed (negative control)', () => {
    const fixture = {
      'notes.delete': { treatment: 'staged', milestone: 2, note: 'trash' },
      'notes.update': { treatment: 'real', note: 'routes by field', fields: { title: { treatment: 'staged', milestone: 1, note: 'rename' } } },
    } satisfies Record<string, InventoryEntry>;
    expect(expiredStaged(fixture, null)).toEqual([]);
    expect(expiredStaged(fixture, 0)).toEqual([]);
    expect(expiredStaged(fixture, 1)).toEqual(['notes.update#title']);
    expect(expiredStaged(fixture, 2)).toEqual(['notes.delete', 'notes.update#title']);
  });

  it('has no staged entry past its milestone (TRACE_MILESTONE is the last closed milestone in CI)', () => {
    expect(closedMilestone('')).toBeNull();
    expect(closedMilestone('2')).toBe(2);
    expect(expiredStaged(INVENTORY, closedMilestone(process.env.TRACE_MILESTONE))).toEqual([]);
  });
});
