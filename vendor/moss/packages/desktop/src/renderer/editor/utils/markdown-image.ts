// ported-from: packages/desktop/src/renderer/editor/utils/markdown-image.ts @ 762abb777
import { normalizeWebBrowserUrl } from '../../../common/web-embed-url';
import {
  isTwitterStatusUrl,
  normalizeEmbeddableWebUrl
} from './web-embed-classify';
// moss-multi seam: converter-split (A§12; S-conv §2.3)
import { isHttpsImageUrl } from './https-image-url';
import { isLocalVideoPath, isYouTubeUrl } from './video-url';

export type ClassifiedMarkdownImage = {
  altText: string;
  kind: 'image' | 'unsupported-remote-video' | 'video' | 'web-embed';
  src: string;
};

type ParsedMarkdownImageLine = {
  altText: string;
  src: string;
};

const normalizeLocalImageSrc = (src: string): string => {
  if (/^https?:\/\//i.test(src)) return src;
  return src
    .replace(/\u200B&#8239;\u200B/g, ' ')
    .replace(/&#8239;/g, ' ')
    .replace(/\u202f/g, ' ');
};

const parseMarkdownImageLine = (line: string): ParsedMarkdownImageLine | null => {
  if (!line.startsWith('![')) {
    return null;
  }

  let cursor = 2;
  let altText = '';

  while (cursor < line.length) {
    const char = line[cursor];
    if (char === '\\' && cursor + 1 < line.length) {
      const next = line[cursor + 1];
      if (next === ']' || next === '\\') {
        altText += next;
        cursor += 2;
        continue;
      }
    }
    if (char === ']') {
      break;
    }
    altText += char;
    cursor += 1;
  }

  if (cursor >= line.length || line[cursor] !== ']') {
    return null;
  }
  cursor += 1;

  if (cursor >= line.length || line[cursor] !== '(') {
    return null;
  }
  cursor += 1;

  let src = '';
  let depth = 1;
  let escaped = false;

  while (cursor < line.length) {
    const char = line[cursor];
    if (escaped) {
      src += char;
      escaped = false;
      cursor += 1;
      continue;
    }
    if (char === '\\') {
      src += char;
      escaped = true;
      cursor += 1;
      continue;
    }
    if (char === '(') {
      depth += 1;
      src += char;
      cursor += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      cursor += 1;
      if (depth === 0) {
        break;
      }
      src += char;
      continue;
    }
    src += char;
    cursor += 1;
  }

  if (depth !== 0 || line.slice(cursor).trim().length > 0) {
    return null;
  }

  const trimmedSrc = src.trim();
  if (trimmedSrc.length === 0) {
    return null;
  }

  const titleMatch = trimmedSrc.match(/^(.+?)\s+"(?:[^"\\]|\\.)*"\s*$/);
  const sourceWithoutTitle = titleMatch?.[1]?.trim() ?? trimmedSrc;
  if (sourceWithoutTitle.length === 0) {
    return null;
  }
  return { altText, src: normalizeLocalImageSrc(sourceWithoutTitle) };
};

export function classifyMarkdownImageLine(line: string): ClassifiedMarkdownImage | null {
  const parsed = parseMarkdownImageLine(line);
  if (!parsed) {
    return null;
  }

  const mediaSrc = /^https?:\/\//i.test(parsed.src)
    ? parsed.src
    : (normalizeWebBrowserUrl(parsed.src) ?? parsed.src);
  if (isLocalVideoPath(mediaSrc) && /^https?:\/\//i.test(mediaSrc)) {
    return { ...parsed, kind: 'unsupported-remote-video', src: mediaSrc };
  }
  if (isLocalVideoPath(mediaSrc) || isYouTubeUrl(mediaSrc)) {
    return { ...parsed, kind: 'video', src: mediaSrc };
  }
  if (isTwitterStatusUrl(mediaSrc)) {
    return { ...parsed, kind: 'web-embed', src: mediaSrc };
  }
  if (isHttpsImageUrl(mediaSrc)) {
    return { ...parsed, kind: 'image', src: mediaSrc };
  }
  const embedUrl = normalizeEmbeddableWebUrl(parsed.src);
  if (embedUrl) {
    return { ...parsed, kind: 'web-embed', src: embedUrl };
  }
  return { ...parsed, kind: 'image' };
}
