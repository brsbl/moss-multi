// Pixel comparison (S-test §5.4): pad to a common canvas (never resize), paint the same masks on both sides,
// pixelmatch at threshold 0.1 without anti-aliased pixels, and label 8-connected diff blobs.
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface Rect { x: number; y: number; width: number; height: number }

export interface Metrics {
  width: number;
  height: number;
  oracle: { width: number; height: number };
  candidate: { width: number; height: number };
  sizeDelta: { dw: number; dh: number };
  diffPixels: number;
  /** Percent of the canvas. */
  diffPct: number;
  /** Largest 8-connected diff component, in device px. */
  maxBlob: number;
  /** Percent of the canvas painted out by masks. */
  maskedPct: number;
}

export interface Comparison { metrics: Metrics; diff: PNG; triptych: PNG }

const PAD = [255, 0, 255, 255]; // padding never matches real pixels
const MASK = [128, 128, 128, 255];

function onCanvas(png: PNG, width: number, height: number, masks: Rect[]): PNG {
  const out = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) out.data.set(PAD, i * 4);
  PNG.bitblt(png, out, 0, 0, png.width, png.height, 0, 0);
  for (const r of masks) {
    for (let y = Math.max(0, r.y); y < Math.min(height, r.y + r.height); y += 1) {
      for (let x = Math.max(0, r.x); x < Math.min(width, r.x + r.width); x += 1) out.data.set(MASK, (y * width + x) * 4);
    }
  }
  return out;
}

/** Largest 8-connected component of `mask` (1 = differing pixel). */
export function largestBlob(mask: Uint8Array, width: number, height: number): number {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  let largest = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let size = 0;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top > 0) {
      const at = stack[--top];
      size += 1;
      const x = at % width;
      const y = (at - x) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (mask[next] && !seen[next]) {
            seen[next] = 1;
            stack[top++] = next;
          }
        }
      }
    }
    largest = Math.max(largest, size);
  }
  return largest;
}

export function compare(oracleBytes: Buffer, candidateBytes: Buffer, masks: Rect[] = []): Comparison {
  const oracle = PNG.sync.read(oracleBytes);
  const candidate = PNG.sync.read(candidateBytes);
  const width = Math.max(oracle.width, candidate.width);
  const height = Math.max(oracle.height, candidate.height);
  const a = onCanvas(oracle, width, height, masks);
  const b = onCanvas(candidate, width, height, masks);
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, width, height, { threshold: 0.1, includeAA: false });
  // pixelmatch paints counted pixels pure red; anti-aliased ones yellow and the rest faded grey.
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i += 1) {
    const [r, g, bl] = [diff.data[i * 4], diff.data[i * 4 + 1], diff.data[i * 4 + 2]];
    mask[i] = r === 255 && g === 0 && bl === 0 ? 1 : 0;
  }
  const maskedArea = new Uint8Array(width * height);
  for (const r of masks) {
    for (let y = Math.max(0, r.y); y < Math.min(height, r.y + r.height); y += 1) {
      maskedArea.fill(1, y * width + Math.max(0, r.x), y * width + Math.min(width, r.x + r.width));
    }
  }
  const masked = maskedArea.reduce((sum, v) => sum + v, 0);
  const triptych = new PNG({ width: width * 3, height });
  PNG.bitblt(a, triptych, 0, 0, width, height, 0, 0);
  PNG.bitblt(b, triptych, 0, 0, width, height, width, 0);
  PNG.bitblt(diff, triptych, 0, 0, width, height, width * 2, 0);
  const total = width * height;
  return {
    metrics: {
      width,
      height,
      oracle: { width: oracle.width, height: oracle.height },
      candidate: { width: candidate.width, height: candidate.height },
      sizeDelta: { dw: candidate.width - oracle.width, dh: candidate.height - oracle.height },
      diffPixels,
      diffPct: (diffPixels / total) * 100,
      maxBlob: largestBlob(mask, width, height),
      maskedPct: (masked / total) * 100,
    },
    diff,
    triptych,
  };
}
