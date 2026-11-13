/** FNV-1a of the text's UTF-16 code units, hex: a measurement compares two exports by it without shipping them. */
export function textHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `${text.length}:${hash.toString(16)}`;
}
