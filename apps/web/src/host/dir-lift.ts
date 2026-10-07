// T3.S6: Lexical gives each top-level block `dir="auto"`, and WebKit recomputes an auto direction over the whole
// element for every child added to it: at 8,000 list items each item inserted cost 2.5 ms (0.02 ms without the
// attribute), so a 30,000-item list took minutes to land, for the paster and for every peer it reached. While many
// children land in a list or table, its element goes without the attribute; it is put back right after.
import type { LexicalEditor } from 'lexical';
import * as Y from 'yjs';

/** Top-level elements whose `dir` is lifted, and its value. */
export class DirLift {
  readonly #lifted = new Map<HTMLElement, string>();

  lift(element: HTMLElement): void {
    const dir = element.getAttribute('dir');
    if (dir === null || this.#lifted.has(element)) return;
    this.#lifted.set(element, dir);
    element.removeAttribute('dir');
  }

  restore(): void {
    for (const [element, dir] of this.#lifted) if (!element.hasAttribute('dir')) element.setAttribute('dir', dir);
    this.#lifted.clear();
  }
}

/** A remote transaction adding at least this many items (characters, blocks, list items) lifts. */
const LARGE_ITEMS = 500;
/** Only elements holding at least this many children pay noticeably per child added. */
const LARGE_CHILDREN = 128;

/**
 * A peer's large paste reaches `editor` as remote transactions on `doc` of thousands of list items or rows. Lexical
 * reconciles each in a microtask after the transaction; until then the large top-level elements go without `dir`.
 */
export function liftDirOnLargeRemote(editor: LexicalEditor, doc: Y.Doc): () => void {
  const lift = new DirLift();
  let restoring: ReturnType<typeof setTimeout> | undefined;
  const onTransaction = (transaction: Y.Transaction) => {
    if (transaction.local) return;
    let added = 0;
    for (const [client, clock] of transaction.afterState) added += clock - (transaction.beforeState.get(client) ?? 0);
    if (added < LARGE_ITEMS) return;
    const root = editor.getRootElement();
    if (!root) return;
    for (const child of root.children) {
      if (child.childElementCount >= LARGE_CHILDREN) lift.lift(child as HTMLElement);
    }
    // After the microtask that reconciles the change.
    restoring ??= setTimeout(() => {
      restoring = undefined;
      lift.restore();
    }, 0);
  };
  doc.on('afterTransaction', onTransaction);
  return () => {
    doc.off('afterTransaction', onTransaction);
    clearTimeout(restoring);
    lift.restore();
  };
}
