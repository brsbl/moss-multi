// The affordance drift test (A§9): the hide registry and the vendored render sites agree in both directions,
// PRODUCT's named set is registered, staged entries expire with their milestone, and the native-only items
// PRODUCT names but moss never renders at the pin stay unlisted.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AFFORDANCES, hidden } from './affordances.ts';
import { createBridge } from './bridge/index.ts';
import { closedMilestone, expiredStaged } from './bridge/inventory.ts';

const PACKAGES = fileURLToPath(new URL('../../../../vendor/moss/packages/', import.meta.url));
const READ = /\bhidden\('([a-z0-9-]+)'\)/g;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const vendorFiles = [...sources(join(PACKAGES, 'desktop/src/renderer')), ...sources(join(PACKAGES, 'shared/src'))];
const reads = (text: string) => [...text.matchAll(READ)].map((match) => match[1]);

describe('the hide registry', () => {
  it("registers PRODUCT's named set and the same-rule entries (P:Agents; A§9)", () => {
    const ids = AFFORDANCES.map((entry) => entry.id);
    for (const id of [
      'share-with-agent', 'ai-run-action', 'reveal-in-finder', 'open-directory', 'settings-workspace-location',
      'settings-default-md-editor', 'settings-connected-folders', 'create-note-shortcut-label',
      'title-shortcut-label', 'emoji-panel', 'browser-back-forward', 'browser-find',
    ]) {
      expect(ids, id).toContain(id);
    }
    expect(new Set(ids).size, 'ids are unique').toBe(ids.length);
  });

  it('gives every entry a reason, a citation, existing sites and a probe', () => {
    for (const entry of AFFORDANCES) {
      expect(entry.reason.length, entry.id).toBeGreaterThan(10);
      expect(entry.cite.length, entry.id).toBeGreaterThan(1);
      expect(entry.probes.length, entry.id).toBeGreaterThan(0);
      for (const site of entry.sites) expect(existsSync(join(PACKAGES, site)), `${entry.id}: ${site}`).toBe(true);
    }
  });

  it('is read at every listed site, through a marked seam', () => {
    for (const entry of AFFORDANCES) {
      for (const site of entry.sites) {
        const text = readFileSync(join(PACKAGES, site), 'utf8');
        expect(reads(text), `${site} reads hidden('${entry.id}')`).toContain(entry.id);
        expect(text, `${site} marks its seam`).toMatch(/moss-multi seam: hide-registry/);
      }
    }
  });

  it('has an entry for every vendored read, listed at that site', () => {
    const problems: string[] = [];
    for (const file of vendorFiles) {
      const site = file.slice(PACKAGES.length).replaceAll('\\', '/');
      for (const id of reads(readFileSync(file, 'utf8'))) {
        const entry = AFFORDANCES.find((candidate) => candidate.id === id);
        if (!entry) problems.push(`${site} reads unregistered '${id}'`);
        else if (!(entry.sites as readonly string[]).includes(site)) problems.push(`${site} reads '${id}' but is not one of its sites`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('hides every registered id', () => {
    for (const entry of AFFORDANCES) expect(hidden(entry.id), entry.id).toBe(true);
  });

  it('has no staged entry past its milestone', () => {
    const staged = Object.fromEntries(
      AFFORDANCES.filter((entry) => 'staged' in entry).map((entry) => [entry.id, { treatment: 'staged' as const, milestone: (entry as { staged: number }).staged, note: entry.reason }]),
    );
    // T4.4 unstaged the last entry (comment edit and delete); a later staged entry is held to the same expiry.
    expect(expiredStaged(staged, closedMilestone(process.env.TRACE_MILESTONE))).toEqual([]);
    expect(expiredStaged(staged, 4), 'every staged entry expires by M4').toEqual(Object.keys(staged));
  });

  // Quick capture, auto-update, "open in default app" and in-embed ⌘K capture are named by PRODUCT but have no
  // render site on the web at the pin, so registering them would claim work the registry does not do.
  it('leaves the never-rendered native items unlisted, and they stay unreachable', async () => {
    const ids: string[] = AFFORDANCES.map((entry) => entry.id);
    for (const id of ['quick-capture', 'auto-update', 'open-in-default-app', 'embed-command-capture']) expect(ids).not.toContain(id);
    const bridge = createBridge({ pathname: () => '/', fetch: async () => Response.json({}) });
    let updateShown = false;
    bridge.update.onReady(() => {
      updateShown = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updateShown, 'UpdateWidget mounts only after update.onReady fires').toBe(false);
    expect((await bridge.system.getGlobalShortcut()).enabled, 'quick capture is never enabled').toBe(false);
    expect('remoteWebSurface' in bridge, 'the in-embed capture lives on the native web surface').toBe(false);
    const renderer = vendorFiles.filter((file) => /\.tsx$/.test(file)).map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(renderer, 'no "open in default app" item at the pin').not.toMatch(/Open in Default App/i);
    expect(renderer, 'no quick-capture row in Settings at the pin').not.toMatch(/>\s*Quick Capture\s*</);
  });
});
