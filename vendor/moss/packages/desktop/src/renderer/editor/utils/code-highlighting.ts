// ported-from: packages/desktop/src/renderer/editor/utils/code-highlighting.ts @ 762abb777
import { Prism } from '../plugins/code-block/prism-setup';
import { getPrismKey } from '../plugins/code-block/languages';

export function escapeCodeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function highlightCodeToHtml(code: string, language: string): string {
  const prismKey = getPrismKey(language);
  let html: string;

  if (!prismKey || !Prism.languages[prismKey]) {
    html = escapeCodeHtml(code);
  } else {
    try {
      html = Prism.highlight(code, Prism.languages[prismKey], prismKey);
    } catch {
      html = escapeCodeHtml(code);
    }
  }

  return html
    .split('\n')
    .map((line) => `<span class="moss-codeblock-line">${line || ' '}</span>`)
    .join('');
}
