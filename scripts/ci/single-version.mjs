#!/usr/bin/env node
// Tests-first harness stub: reports nothing. The real check replaces this.
import { pathToFileURL } from 'node:url';

export function parseLockfile() {
  return { version: '', overrides: new Map(), packages: new Map() };
}

export function checkSingleVersions() {
  return { problems: [], resolved: new Map() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('single-version: stub');
}
