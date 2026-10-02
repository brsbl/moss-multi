#!/usr/bin/env node
// Reads the provenance baked into a built dist (apps/web/vite-provenance.ts).
//   node scripts/provenance.mjs read <dist>    prints commit=, headSha=, bundleHash=, clientHash= for $GITHUB_OUTPUT
// Fails unless the Worker carries exactly one provenance record and the client carries the same clientHash.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const field = (name, value) => new RegExp(`["']?\\b${name}["']?\\s*:\\s*["'\`](${value})["'\`]`, 'g');
const HEX40 = '[0-9a-f]{40}';
const HEX64 = '[0-9a-f]{64}';
const WORKER_FIELDS = { commit: HEX40, headSha: HEX40, bundleHash: HEX64, clientHash: HEX64 };

function scripts(dir) {
  const files = [];
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (/\.m?js$/.test(entry.name)) files.push(child);
    }
  };
  walk(dir);
  return files.map((file) => readFileSync(file, 'utf8'));
}

function single(texts, name, value, where) {
  const found = texts.flatMap((text) => [...text.matchAll(field(name, value))].map((match) => match[1]));
  if (found.length !== 1) throw new Error(`provenance: ${where} has ${found.length} ${name} slots, expected 1`);
  return found[0];
}

export function readProvenance(dist) {
  const worker = scripts(join(dist, 'server'));
  const provenance = {};
  for (const [name, value] of Object.entries(WORKER_FIELDS)) provenance[name] = single(worker, name, value, 'the Worker');
  const client = scripts(join(dist, 'client'));
  const clientHash = single(client, 'clientHash', HEX64, 'the client');
  if (clientHash !== provenance.clientHash) {
    throw new Error(`provenance: client clientHash ${clientHash} does not match the Worker's ${provenance.clientHash}`);
  }
  return provenance;
}

function main([command, dist]) {
  if (command !== 'read' || !dist) {
    console.error('usage: node scripts/provenance.mjs read <dist>');
    return 2;
  }
  try {
    const provenance = readProvenance(dist);
    process.stdout.write(Object.entries(provenance).map(([key, value]) => `${key}=${value}\n`).join(''));
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
