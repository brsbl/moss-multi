import type { Actor } from './actors.ts';
import { body } from './ui.ts';

/** A real clipboard event, also supported by WebKit where navigator.clipboard.readText is unavailable. */
export async function pasteMarkdown(actor: Actor, docId: string, markdown: string): Promise<void> {
  const target = body(actor, docId);
  await target.click();
  await target.evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    data.setData('text/markdown', text);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, markdown);
  await actor.page.keyboard.press('Escape');
  await actor.page.mouse.click(0, 0);
  await target.evaluate((element) => {
    (element as HTMLElement).blur();
    window.getSelection()?.removeAllRanges();
  });
}

/** Keep structure, text, formatting and payload attributes; remove only instance identity and selection paint. */
export async function renderedBody(actor: Actor, docId: string) {
  return body(actor, docId).evaluate((element) => {
    const root = element.cloneNode(true) as HTMLElement;
    const identities = /^(id|data-(?:.*-key|formula-id|note-id|doc-id|lexical-managed-linebreak)|aria-(?:controls|labelledby|describedby|activedescendant))$/;
    // Lexical's block cursor is selection paint, not a node. Table widths are per-viewer layout (A§10.9).
    root.querySelectorAll('[data-lexical-cursor]').forEach((cursor) => cursor.remove());
    root.querySelectorAll<HTMLElement>('table, col').forEach((table) => {
      table.style.removeProperty('width');
      table.style.removeProperty('min-width');
      if (!table.getAttribute('style')) table.removeAttribute('style');
    });
    const ids = new Map([...root.querySelectorAll('[id]')].map((el, i) => [el.id, `instance-${i}`]));
    for (const node of [root, ...root.querySelectorAll('*')]) {
      for (const attr of [...node.attributes]) {
        if (identities.test(attr.name)) node.removeAttribute(attr.name);
        else node.setAttribute(attr.name, attr.value.replace(/url\(#([^)]+)\)/g, (_, id: string) => `url(#${ids.get(id) ?? id})`));
      }
      node.classList.remove('selected', 'selected-editor');
      if (!node.getAttribute('class')) node.removeAttribute('class');
      const attrs = [...node.attributes].sort((a, b) => a.name.localeCompare(b.name));
      for (const attr of [...node.attributes]) node.removeAttribute(attr.name);
      for (const attr of attrs) node.setAttribute(attr.name, attr.value);
    }
    // The body binding's root carries readiness and actor identity, rather than authored content.
    const dom = root.innerHTML;
    const counts: Record<string, number> = {};
    for (const node of root.querySelectorAll('[data-lexical-decorator]')) {
      const kind = [...node.attributes].filter((a) => a.name.startsWith('data-') && !identities.test(a.name))
        .map((a) => `${a.name}=${a.value}`).sort().join(' ');
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    return { dom, decorators: counts };
  });
}
