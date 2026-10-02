#!/usr/bin/env node
// Tests-first harness stub: finds nothing. The real check replaces this.
import { pathToFileURL } from 'node:url';

export function parseTrace() {
  return { rows: [], problems: [] };
}

export function collectTags() {
  return new Map();
}

export function listLegFiles() {
  return [];
}

export function checkTrace() {
  return { problems: [] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('trace: stub');
}
