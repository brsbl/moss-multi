#!/usr/bin/env node
// Tests-first harness stub. The real counter replaces this.
import { pathToFileURL } from 'node:url';

export function jobMinutes() {
  return 0;
}

export function summarize() {
  return { jobs: 0, minutes: 0, budget: 0 };
}

export function monthRange() {
  return '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('minutes: stub');
}
