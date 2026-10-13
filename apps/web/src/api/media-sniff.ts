// Whether stored bytes are the media type their name declares (A§16): a fixed-offset signature per raster and video
// container, read from the first bytes only, and for SVG an XML document whose root element is <svg>.

const ascii = (bytes: Uint8Array, offset: number, text: string) =>
  bytes.length >= offset + text.length && [...text].every((char, i) => bytes[offset + i] === char.charCodeAt(0));

const startsWith = (bytes: Uint8Array, signature: readonly number[]) =>
  bytes.length >= signature.length && signature.every((byte, i) => bytes[i] === byte);

/** The top-level box types an ISO BMFF file (mp4, and QuickTime's mov, older files included) may open with. */
const BMFF_BOXES = ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'uuid'];

/** `bytes` as text, by its byte-order mark (UTF-8 without one), for the SVG prolog scan. */
function decodeText(bytes: Uint8Array<ArrayBuffer>): string {
  if (startsWith(bytes, [0xff, 0xfe])) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (startsWith(bytes, [0xfe, 0xff])) {
    const swapped = new Uint8Array(bytes.length - 2 - (bytes.length % 2));
    for (let i = 0; i < swapped.length; i += 2) {
      swapped[i] = bytes[i + 3];
      swapped[i + 1] = bytes[i + 2];
    }
    return new TextDecoder('utf-16le').decode(swapped);
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
