// Properties are independent map entries; YAML exists only at the file boundary (A§10.4).
import jsYaml from 'js-yaml';
import * as Y from 'yjs';

const DUMP = { lineWidth: -1, noRefs: true, sortKeys: false, quotingType: '"' } as const;
export type Frontmatter = Record<string, unknown> | null;

/** Preserve moss's date strings, including dates nested in lists and mappings. */
function normalizeDates(value: unknown): unknown {
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (Array.isArray(value)) return value.map(normalizeDates);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeDates(entry)]));
  return value;
}

/** Accept both the old fenced storage format and YAML from a file's frontmatter block. */
export function parseFrontmatter(yaml: string): Frontmatter {
  const fenced = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(yaml);
  try {
    const parsed: unknown = jsYaml.load(fenced ? fenced[1] : yaml, { json: true });
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? normalizeDates(parsed) as Frontmatter : null;
  } catch { return null; }
}

/** Order-insensitive equality for nested values; top-level order is tracked separately. */
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
};

/** Duplicate order entries from concurrent additions are displayed once; missing keys have a stable fallback. */
export function frontmatterKeys(doc: Y.Doc): string[] {
  const map = doc.getMap('frontmatter');
  const order = doc.getArray<string>('frontmatterOrder').toArray();
  return [...new Set([...order, ...[...map.keys()].sort()])].filter((key) => map.has(key));
}

export function readFrontmatter(doc: Y.Doc): Frontmatter {
  const map = doc.getMap('frontmatter');
  const keys = frontmatterKeys(doc);
  return keys.length ? Object.fromEntries(keys.map((key) => [key, map.get(key)])) : null;
}

export function frontmatterYaml(doc: Y.Doc): string {
  const data = readFrontmatter(doc);
  return data ? jsYaml.dump(data, DUMP) : '';
}

/** Apply only the values changed by this edit, in one transaction with its ordering intent. */
export function updateFrontmatter(doc: Y.Doc, before: Frontmatter, after: Frontmatter, origin: unknown): boolean {
  const map = doc.getMap('frontmatter');
  const order = doc.getArray<string>('frontmatterOrder');
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  const changed = keys.filter((key) => stable(before?.[key]) !== stable(after?.[key]));
  const desired = Object.keys(after ?? {}).filter((key) => after?.[key] !== undefined);
  const retained = new Set(Object.keys(before ?? {}).filter((key) => desired.includes(key)));
  const reordered = JSON.stringify(Object.keys(before ?? {}).filter((key) => retained.has(key))) !==
    JSON.stringify(desired.filter((key) => retained.has(key)));
  if (!changed.length && !reordered) return false;
  doc.transact(() => {
    for (const key of changed) {
      const value = after?.[key];
      if (value === undefined) map.delete(key);
      else {
        map.set(key, value);
        if (!order.toArray().includes(key)) order.push([key]);
      }
    }
    if (reordered) {
      // Ordering conflicts cannot delete values. Concurrent order inserts are deduplicated on read.
      const others = frontmatterKeys(doc).filter((key) => !desired.includes(key));
      order.delete(0, order.length);
      order.push([...desired, ...others]);
    }
  }, origin);
  return true;
}

export function writeFrontmatterKey(doc: Y.Doc, key: string, value: unknown, origin: unknown): boolean {
  const before = readFrontmatter(doc);
  return updateFrontmatter(doc, before, { ...before, [key]: value }, origin);
}

/** File import replaces the properties together; interactive edits use updateFrontmatter's baseline. */
export function importFrontmatter(doc: Y.Doc, yaml: string, origin: unknown): boolean {
  const data = parseFrontmatter(yaml);
  if (yaml.trim() && !data && !/^---\r?\n\s*---\s*$/.test(yaml)) throw new Error('Invalid frontmatter');
  return updateFrontmatter(doc, readFrontmatter(doc), data, origin);
}

export function observeFrontmatter(doc: Y.Doc, listener: (data: Frontmatter, origin: unknown) => void): () => void {
  const map = doc.getMap('frontmatter');
  const order = doc.getArray<string>('frontmatterOrder');
  const changed = (transaction: Y.Transaction) => {
    const types: ReadonlyMap<unknown, unknown> = transaction.changed;
    if (types.has(map) || types.has(order)) listener(readFrontmatter(doc), transaction.origin);
  };
  doc.on('afterTransaction', changed);
  return () => doc.off('afterTransaction', changed);
}

/** Upgrade a replayed legacy snapshot before any caller declares its frontmatter root type. */
export function migrateFrontmatter(doc: Y.Doc, origin: unknown): void {
  if (!doc.share.has('frontmatter') || doc.getMap('frontmatterMigration').get('structured') === true) return;
  const legacy = new Y.Doc();
  let yaml: string;
  try {
    // Root constructors are local views, absent from the wire. Read the old sequence in a separate view.
    Y.applyUpdate(legacy, Y.encodeStateAsUpdate(doc));
    yaml = legacy.getText('frontmatter').toString();
  } finally { legacy.destroy(); }
  if (!yaml.trim()) return;
  const data = parseFrontmatter(yaml);
  if (!data) throw new Error('Invalid legacy frontmatter');
  doc.transact(() => {
    const map = doc.getMap('frontmatter');
    for (const [key, value] of Object.entries(data)) if (!map.has(key)) map.set(key, value);
    const order = doc.getArray<string>('frontmatterOrder');
    const known = new Set(order.toArray());
    order.push(Object.keys(data).filter((key) => !known.has(key)));
    // Retain old wire items and mark the upgrade so a deleted map key never reappears on reload.
    doc.getMap('frontmatterMigration').set('structured', true);
  }, origin);
}

/** Standalone file editing uses canonical YAML, with no CRDT text mutation. */
export function setFrontmatterKey(yaml: string, key: string, value: unknown): string {
  const data = { ...parseFrontmatter(yaml), [key]: value };
  if (value === undefined) delete data[key];
  return Object.keys(data).length ? jsYaml.dump(data, DUMP) : '';
}

export function composeFrontmatter(yaml: string, body: string): string {
  if (!yaml.trim()) return body;
  return `---\n${yaml.endsWith('\n') ? yaml : `${yaml}\n`}---\n${body}`;
}
