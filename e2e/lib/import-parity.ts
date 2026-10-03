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
  await target.evaluate((element) => {
    (element as HTMLElement).blur();
    window.getSelection()?.removeAllRanges();
  });
}

/** Keep structure, text, formatting and payload attributes; remove only instance identity and selection paint. */
export async function renderedBody(actor: Actor, docId: string) {
  return body(actor, docId).evaluate((element) => {
    const root = element.cloneNode(true) as HTMLElement;
    const identities = /^(id|data-(?:lexical-key|node-key|formula-id|note-id|doc-id)|aria-(?:controls|labelledby|describedby|activedescendant))$/;
    for (const node of [root, ...root.querySelectorAll('*')]) {
      for (const attr of [...node.attributes]) {
        if (identities.test(attr.name)) node.removeAttribute(attr.name);
      }
      node.classList.remove('selected', 'selected-editor');
      if (!node.getAttribute('class')) node.removeAttribute('class');
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
