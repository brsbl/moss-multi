// Whether stored bytes are the media type their name declares (A§16): a fixed-offset signature per raster and video
// container, read from the first bytes only, and for SVG an XML document whose root element is <svg>.

const ascii = (bytes: Uint8Array, offset: number, text: string) =>
  bytes.length >= offset + text.length && [...text].every((char, i) => bytes[offset + i] === char.charCodeAt(0));

const startsWith = (bytes: Uint8Array, signature: readonly number[]) =>
  bytes.length >= signature.length && signature.every((byte, i) => bytes[i] === byte);

/** The top-level box types an ISO BMFF file (mp4, and QuickTime's mov, older files included) may open with. */
const BMFF_BOXES = ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'uuid'];

/** IBM037 (EBCDIC) bytes of the printable ASCII characters, in ASCII order, then tab, CR, NEL and LF. */
const EBCDIC_BYTES =
  '405a7f7b5b6c507d4d5d5c4e6b604b61f0f1f2f3f4f5f6f7f8f97a5e4c7e6e6f7cc1c2c3c4c5c6c7c8c9d1d2d3d4d5d6d7d8d9e2e3e4e5e6e7e8e9bae0bbb06d79818283848586878889919293949596979899a2a3a4a5a6a7a8a9c04fd0a1050d1525';
const EBCDIC_TEXT = `${Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('')}\t\r\n\n`;
const EBCDIC = new Map(EBCDIC_TEXT.split('').map((char, i) => [parseInt(EBCDIC_BYTES.slice(i * 2, i * 2 + 2), 16), char]));

/** Code points read as `size`-byte units whose bytes, most significant first, sit at `order` within each unit. */
function decodeUnits(bytes: Uint8Array, size: 2 | 4, order: readonly number[]): string {
  const units = new Uint32Array(Math.floor(bytes.length / size));
  for (let u = 0; u < units.length; u += 1) {
    const value = order.reduce((sum, offset) => sum * 256 + bytes[u * size + offset], 0);
    units[u] = size === 2 || (value <= 0x10ffff && (value < 0xd800 || value >= 0xe000)) ? value : 0xfffd;
  }
  let text = '';
  for (let at = 0; at < units.length; at += 8192) {
    const chunk = Array.from(units.subarray(at, at + 8192));
    text += size === 2 ? String.fromCharCode(...chunk) : String.fromCodePoint(...chunk);
  }
  return text;
}

/** UCS-4's four byte orders (XML 1.0 Appendix F's 1234, 4321, 2143 and 3412), as `decodeUnits` orders. */
const UCS4 = [
  [0, 1, 2, 3],
  [3, 2, 1, 0],
  [1, 0, 3, 2],
  [2, 3, 0, 1],
] as const;

/**
 * `bytes` as text for the SVG prolog scan, its encoding detected as XML 1.0 Appendix F does: UCS-4/UTF-32 in any
 * byte order, UTF-16 either way, EBCDIC, each with or without a byte-order mark, and UTF-8 (or any ASCII-compatible
 * encoding, whose markup reads the same) otherwise.
 */
function decodeText(bytes: Uint8Array): string {
  const head = [0, 1, 2, 3].map((i) => bytes[i] ?? -1);
  for (const order of UCS4) {
    const unit = order.map((at) => head[at]);
    if (unit[0] === 0 && unit[1] === 0 && ((unit[2] === 0xfe && unit[3] === 0xff) || (unit[2] === 0 && unit[3] > 0))) {
      return decodeUnits(bytes, 4, order).replace(/^\uFEFF/, '');
    }
  }
  if ((head[0] === 0xfe && head[1] === 0xff) || (head[0] === 0 && head[1] > 0 && head[2] === 0 && head[3] > 0)) {
    return decodeUnits(bytes, 2, [0, 1]).replace(/^\uFEFF/, '');
  }
  if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] > 0 && head[1] === 0 && head[2] > 0 && head[3] === 0)) {
    return decodeUnits(bytes, 2, [1, 0]).replace(/^\uFEFF/, '');
  }
  if (head[0] === 0x4c && head[1] === 0x6f && head[2] === 0xa7 && head[3] === 0x94) {
    return Array.from(bytes, (byte) => EBCDIC.get(byte) ?? '\uFFFD').join('');
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Whether the document's root element is `<svg>` (any namespace prefix): past an XML declaration, processing
 * instructions, comments, a doctype (internal subset included) and whitespace. One forward scan.
 */
export function isSvgDocument(bytes: Uint8Array<ArrayBuffer>): boolean {
  const text = decodeText(bytes);
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i])) i += 1;
  };
  for (;;) {
    skipSpace();
    if (text.startsWith('<?', i) || text.startsWith('<!--', i)) {
      const close = text.startsWith('<?', i) ? '?>' : '-->';
      const end = text.indexOf(close, i + 2);
      if (end < 0) return false;
      i = end + close.length;
      continue;
    }
    if (text.slice(i, i + 9).toUpperCase() === '<!DOCTYPE') {
      i = doctypeEnd(text, i);
      if (i < 0) return false;
      continue;
    }
    break;
  }
  // A namespace prefix is any XML name (Unicode included, any length) before the colon.
  const root = /<(?:[^\s:/<>!?"'=]+:)?svg(?=[\s/>])/iy;
  root.lastIndex = i;
  return root.test(text);
}

/**
 * The index just past the doctype opening at `start`, or -1: quoted literals, and comments and processing
 * instructions in the internal subset, may hold brackets and `>`.
 */
function doctypeEnd(text: string, start: number): number {
  let subset = false;
  for (let j = start + 9; j < text.length; j += 1) {
    const char = text[j];
    let close = '';
    if (char === '"' || char === "'") close = char;
    else if (subset && text.startsWith('<!--', j)) close = '-->';
    else if (subset && text.startsWith('<?', j)) close = '?>';
    if (close) {
      const end = text.indexOf(close, j + (close === '-->' ? 4 : close.length === 1 ? 1 : 2));
      if (end < 0) return -1;
      j = end + close.length - 1;
    } else if (char === '[') subset = true;
    else if (char === ']') subset = false;
    else if (char === '>' && !subset) return j + 1;
  }
  return -1;
}

/** Whether `bytes` are a file of `contentType`, one of moss's media types; false for any other type. */
export function bytesMatchType(bytes: Uint8Array<ArrayBuffer>, contentType: string): boolean {
  switch (contentType) {
    case 'image/png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'image/gif':
      return ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a');
    case 'image/webp':
      return ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP');
    case 'image/svg+xml':
      return isSvgDocument(bytes);
    case 'video/webm':
      return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    case 'video/mp4':
    case 'video/quicktime':
      return BMFF_BOXES.some((box) => ascii(bytes, 4, box));
    default:
      return false;
  }
}
