import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readProvenance } from './provenance.mjs';

const COMMIT = 'a'.repeat(40);
const BUNDLE = 'b'.repeat(64);
const CLIENT = 'c'.repeat(64);
const worker = `var BUILD = {\n\t"commit": "${COMMIT}",\n\t"headSha": "${COMMIT}",\n\t"bundleHash": "${BUNDLE}",\n\t"clientHash": "${CLIENT}"\n};`;
const client = (hash = CLIENT) => `var yl={commit:\`${COMMIT}\`,clientHash:\`${hash}\`};`;

const dirs = [];
function dist({ server = [worker], browser = [client()] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'provenance-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'server/assets'), { recursive: true });
  mkdirSync(join(dir, 'client/assets'), { recursive: true });
  server.forEach((code, i) => writeFileSync(join(dir, `server/assets/chunk-${i}.js`), code));
  browser.forEach((code, i) => writeFileSync(join(dir, `client/assets/chunk-${i}.js`), code));
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readProvenance', () => {
  it('reads the one record the build baked in', () => {
    expect(readProvenance(dist())).toEqual({ commit: COMMIT, headSha: COMMIT, bundleHash: BUNDLE, clientHash: CLIENT });
  });

  it('fails on two Worker records', () => {
    expect(() => readProvenance(dist({ server: [worker, worker] }))).toThrow(/2 commit slots, expected 1/);
  });

  it('fails when the Worker has none', () => {
    expect(() => readProvenance(dist({ server: ['export {}'] }))).toThrow(/0 commit slots/);
  });

  it('fails when the client was built from other bytes', () => {
    expect(() => readProvenance(dist({ browser: [client('d'.repeat(64))] }))).toThrow(/does not match/);
  });
});
