// ported-from: packages/desktop/src/common/content-hash.ts @ 762abb777
/**
 * Deterministic 16-char hex hash of string content.
 * Shared across renderer and main process for HTML preview filename derivation.
 * Uses FNV-1a dual-hash for fast synchronous computation.
 */
export function computeContentHash(content: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x6c62272e;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c;
    h2 = Math.imul(h2, 0x01000193);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
