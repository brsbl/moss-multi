// A doc reference (A§17, H-19): a doc id, a URL whose path holds /d/<id>, or a unique prefix of a title.
import type { Api, DocRow } from './api.ts';
import { CliError } from './errors.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DocRef = { kind: 'id'; id: string } | { kind: 'prefix'; prefix: string };

export function parseDocRef(ref: string): DocRef {
  const value = ref.trim();
  if (!value) throw new CliError(1, 'name a doc: its id, its URL or the start of its title');
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new CliError(1, `not a doc URL: ${value}`);
    }
    const match = /\/d\/([^/?#]+)/.exec(url.pathname);
    if (!match) throw new CliError(1, `not a doc URL (it has no /d/<id>): ${value}`);
    return { kind: 'id', id: decodeURIComponent(match[1]) };
  }
  if (UUID.test(value)) return { kind: 'id', id: value.toLowerCase() };
  return { kind: 'prefix', prefix: value };
}

const titleOf = (row: Pick<DocRow, 'title'>) => row.title.trim() || 'Untitled';

/** The doc a title prefix names: case-insensitive, and it must name exactly one doc (an exact title wins). */
export function matchTitle(rows: DocRow[], prefix: string): DocRow {
  const wanted = prefix.toLocaleLowerCase();
  const exact = rows.filter((row) => titleOf(row).toLocaleLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  const matches = exact.length > 1 ? exact : rows.filter((row) => titleOf(row).toLocaleLowerCase().startsWith(wanted));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new CliError(1, `no doc you can open has a title starting with "${prefix}"`);
  const listed = matches.slice(0, 10).map((row) => `  ${row.id}  ${titleOf(row)}`).join('\n');
  throw new CliError(1, `"${prefix}" matches ${matches.length} docs; use more of the title or an id:\n${listed}`);
}

export async function resolveDocId(api: Api, ref: string): Promise<string> {
  const parsed = parseDocRef(ref);
  return parsed.kind === 'id' ? parsed.id : matchTitle(await api.listDocs(), parsed.prefix).id;
}
