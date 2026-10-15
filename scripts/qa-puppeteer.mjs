// A stand-in for `bb browser-automation` where bb is absent (CI): the same open, list, run and close commands that
// scripts/qa.mjs sends, answered in-process by one puppeteer-core Chrome. A script runs as bb runs it: an async body
// with the `browser` (named and target-id pages), `saveFile` and `readFile` globals, its last expression as the result.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const AsyncFunction = (async () => {}).constructor;
const SAFE_NAME = /^[\w.-]+$/;

/** The script with its last line returned, when that line is an expression (bb prints the last expression's value). */
export function returningLast(source) {
  const lines = source.trimEnd().split('\n');
  const last = lines.at(-1);
  if (/^\s*(?:await\s|\(|[\w$.[\]"']+\s*\()/.test(last) && !/^\s*(?:const|let|var|if|for|while|return|throw|\})\b/.test(last)) {
    lines[lines.length - 1] = `return (${last.replace(/;\s*$/, '')});`;
  }
  return lines.join('\n');
}

/** bb's `--timeout 120s` as milliseconds. */
const millis = (text) => {
  const match = /^(\d+)(ms|s|m)?$/.exec(String(text ?? '90s'));
  if (!match) throw new Error(`bad timeout ${text}`);
  return Number(match[1]) * ({ ms: 1, s: 1000, m: 60_000 }[match[2] ?? 's']);
};

const targetId = (page) => page.target()._targetId;

/** The `browser` global of a bb script over one puppeteer Browser. */
function scriptBrowser(browser, named) {
  return {
    async listPages() {
      return (await browser.pages()).map((page) => ({ id: targetId(page), name: [...named].find(([, p]) => p === page)?.[0] ?? null, url: page.url() }));
    },
    async getPage(key) {
      const byId = (await browser.pages()).find((page) => targetId(page) === key);
      if (byId) return byId;
      const known = named.get(key);
      if (known && !known.isClosed()) return known;
      const page = await browser.newPage();
      named.set(key, page);
      return page;
    },
    newPage: () => browser.newPage(),
  };
}

export function puppeteerBb({ executablePath, headless = true } = {}) {
  if (!executablePath) throw new Error('the puppeteer driver needs Chrome: pass --chrome PATH or set QA_CHROME');
  const sessions = new Map();
  return async function bb(args) {
    const [command, ...rest] = args;
    if (command === 'open') {
      const browser = await puppeteer.launch({
        executablePath,
        headless,
        defaultViewport: null,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
      });
      const id = `pptr-${Date.now().toString(36)}`;
      sessions.set(id, { browser, named: new Map(), files: mkdtempSync(join(tmpdir(), 'qa-pptr-')) });
      return { id };
    }
    if (command === 'list') return [...sessions.keys()].map((id) => ({ id, state: 'running' }));
    if (command === 'close') {
      const session = sessions.get(rest[0]);
      if (!session) throw new Error(`session_unavailable: ${rest[0]}`);
      sessions.delete(rest[0]);
      await session.browser.close().catch(() => {});
      rmSync(session.files, { recursive: true, force: true });
      return { closed: rest[0] };
    }
    if (command === 'run') {
      const session = sessions.get(rest[0]);
      if (!session) throw new Error(`session_unavailable: ${rest[0]}`);
      const option = (name) => rest[rest.indexOf(name) + 1];
      const source = readFileSync(option('--script-file'), 'utf8');
      const file = (name) => {
        if (!SAFE_NAME.test(name)) throw new Error(`bad file name ${name}`);
        return join(session.files, name);
      };
      const saveFile = (name, data) => {
        writeFileSync(file(name), data);
        return file(name);
      };
      const readFile = (name) => readFileSync(file(name), 'utf8');
      const run = new AsyncFunction('browser', 'saveFile', 'readFile', returningLast(source));
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TimeoutError: Timed out after ${option('--timeout')} (deadline)`)), millis(option('--timeout')));
      });
      try {
        const value = await Promise.race([run(scriptBrowser(session.browser, session.named), saveFile, readFile), deadline]);
        return { text: value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2), exitCode: 0 };
      } catch (error) {
        return { text: `${error.name}: ${error.message}`, exitCode: 1 };
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`the puppeteer driver has no ${command} command`);
  };
}
