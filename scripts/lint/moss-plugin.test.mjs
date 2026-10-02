// Negative controls for the repo lint rules, run through the real eslint.config.mjs.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const eslint = new ESLint({ cwd: ROOT });

// Rule reports only: an unknown-rule complaint carries a ruleId but no messageId.
async function errors(code, relativePath) {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, relativePath) });
  return result.messages.filter((message) => message.severity === 2 && message.messageId).map((message) => message.ruleId);
}

describe('moss/no-raw-color in packages/ui', { timeout: 30_000 }, () => {
  it('flags a hex color in a Tailwind arbitrary value', async () => {
    const code = 'export const Chip = () => <span className="bg-[#fff] text-ink">x</span>;\n';
    expect(await errors(code, 'packages/ui/src/Chip.tsx')).toContain('moss/no-raw-color');
  });

  it('flags a color function in a style object', async () => {
    const code = "export const style = { color: 'rgb(12, 34, 56)' };\n";
    expect(await errors(code, 'packages/ui/src/style.ts')).toContain('moss/no-raw-color');
  });

  it('allows moss tokens', async () => {
    const code = 'export const Chip = () => <span className="bg-surface-panel text-ink border-border">x</span>;\n';
    expect(await errors(code, 'packages/ui/src/Chip.tsx')).not.toContain('moss/no-raw-color');
  });

  it('does not apply outside packages/ui', async () => {
    const code = "export const fixtureInk = '#123456';\n";
    expect(await errors(code, 'apps/web/src/fixture.ts')).not.toContain('moss/no-raw-color');
  });
});

describe('moss/no-contenteditable-pick in e2e', { timeout: 30_000 }, () => {
  it('flags [contenteditable=true].first()', async () => {
    const code = "export async function type(page) {\n  await page.locator('[contenteditable=true]').first().type('x');\n}\n";
    expect(await errors(code, 'e2e/journeys/j01-coedit.spec.ts')).toContain('moss/no-contenteditable-pick');
  });

  it('allows a DOM-contract selector', async () => {
    const code = "export async function type(page) {\n  await page.locator('[data-body-binding=live]').first().type('x');\n}\n";
    expect(await errors(code, 'e2e/journeys/j01-coedit.spec.ts')).not.toContain('moss/no-contenteditable-pick');
  });
});

describe('moss/no-historic-tag in host, package and vendor code', { timeout: 30_000 }, () => {
  it('flags a HISTORIC_TAG import in host code', async () => {
    const code = "import { HISTORIC_TAG } from 'lexical';\nexport const tags = [HISTORIC_TAG];\n";
    expect(await errors(code, 'apps/web/src/host/collab/undo.ts')).toContain('moss/no-historic-tag');
  });

  it('flags the literal historic tag in a package', async () => {
    const code = "export const run = (editor, fn) => editor.update(fn, { tag: 'historic' });\n";
    expect(await errors(code, 'packages/sync/src/server-doc.ts')).toContain('moss/no-historic-tag');
  });

  it('flags vendor code even behind an inline disable', async () => {
    const code =
      "// eslint-disable-next-line moss/no-historic-tag\nimport { HISTORIC_TAG } from 'lexical';\nexport const tag = HISTORIC_TAG;\n";
    expect(await errors(code, 'vendor/moss/packages/desktop/src/renderer/editor/x.ts')).toContain('moss/no-historic-tag');
  });
});
