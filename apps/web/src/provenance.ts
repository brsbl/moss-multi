import { BUILD_META } from '@moss-multi/protocol/dom-contract';

// Filled by vite-provenance.ts. The client bundle carries only commit and clientHash.
export interface Build {
  commit: string;
  headSha: string;
  dirty: boolean;
  diffHash: string;
  bundleHash: string;
  clientHash: string;
  buildTime: string;
  env: string;
}

declare const __MOSS_BUILD__: Build;

export const BUILD: Build = __MOSS_BUILD__;

// The SSR value is the Worker's build; the client re-renders whatever the server sent, so hydration matches.
export function buildMeta(): string {
  if (import.meta.env.SSR) return `${BUILD.commit}:${BUILD.bundleHash}`;
  return document.querySelector(`meta[name="${BUILD_META}"]`)?.getAttribute('content') ?? '';
}
