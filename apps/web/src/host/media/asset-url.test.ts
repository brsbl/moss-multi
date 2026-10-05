// The asset-url substitution (T3.1; A§16): moss's note-relative media paths load from the doc's asset route, with
// the share link threaded through; derived files only desktop makes stay unresolvable; clipboard HTML maps back.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromDisplaySrc, toDisplaySrc } from './asset-url.ts';
import { buildMediaServerUrl } from './media-server-url.ts';
import { parseWebAssetUrl, webAssetsInHtml } from './web-asset-url.ts';

afterEach(() => vi.unstubAllGlobals());

describe('toDisplaySrc', () => {
  it("maps an uploaded file to the doc's asset route", () => {
    expect(toDisplaySrc('assets/pattern.png', 'd1')).toBe('/api/docs/d1/assets/pattern.png');
    expect(toDisplaySrc('./assets/clip.webm', 'd1')).toBe('/api/docs/d1/assets/clip.webm');
    expect(toDisplaySrc('assets/a b.png', 'doc/2')).toBe('/api/docs/doc%2F2/assets/a%20b.png');
  });

  it('threads the share link a reader opened the note with', () => {
    vi.stubGlobal('location', { search: '?share=tok%2Fen', origin: 'http://127.0.0.1:8850' });
    expect(toDisplaySrc('assets/pattern.png', 'd1')).toBe('/api/docs/d1/assets/pattern.png?share=tok%2Fen');
  });

  it('leaves remote and data URLs alone, and keeps desktop-only files on moss-asset://', () => {
    expect(toDisplaySrc('https://example.com/a.png', 'd1')).toBe('https://example.com/a.png');
    expect(toDisplaySrc('data:image/png;base64,AA', 'd1')).toBe('data:image/png;base64,AA');
    // Cached previews and video thumbnails are materialized by moss desktop only; the web never has them.
    expect(toDisplaySrc('assets/.moss-cache/html-preview/x.png', 'd1')).toMatch(/^moss-asset:\/\//);
    expect(toDisplaySrc('assets/video-thumb-abc.png', 'd1')).toMatch(/^moss-asset:\/\//);
    expect(toDisplaySrc('/Users/someone/Pictures/a.png', 'd1')).toMatch(/^moss-asset:\/\//);
    expect(toDisplaySrc('assets/pattern.png', null)).toMatch(/^moss-asset:\/\//);
  });

  it('plays video from the same route, which answers Range itself', () => {
    expect(buildMediaServerUrl('assets/clip.mp4', 'd1')).toBe('/api/docs/d1/assets/clip.mp4');
    expect(buildMediaServerUrl('https://example.com/v.mp4', 'd1')).toBeNull();
  });
});

describe('fromDisplaySrc', () => {
  it("reads a note's own asset URL back to moss's relative path, and keeps another note's", () => {
    expect(fromDisplaySrc('/api/docs/d1/assets/pattern.png?share=x', 'd1')).toBe('assets/pattern.png');
    expect(fromDisplaySrc('/api/docs/d1/assets/a%20b.png')).toBe('assets/a b.png');
    expect(fromDisplaySrc('/api/docs/d1/assets/pattern.png', 'd2')).toBe('/api/docs/d1/assets/pattern.png');
    expect(fromDisplaySrc('assets/plain.png', 'd1')).toBe('assets/plain.png');
  });
});

describe('web asset URLs in clipboard HTML', () => {
  it('names the source note and file of each, same-origin only', () => {
    vi.stubGlobal('location', { search: '', origin: 'http://127.0.0.1:8850' });
    expect(parseWebAssetUrl('http://127.0.0.1:8850/api/docs/d1/assets/a.png')).toMatchObject({ noteId: 'd1', filename: 'a.png' });
    expect(parseWebAssetUrl('https://elsewhere.example/api/docs/d1/assets/a.png')).toBeNull();
    const html = '<p>x</p><img src="/api/docs/d1/assets/a.png?share=t"><div data-video-src="/api/docs/d2/assets/c.webm"></div><img src="/api/docs/d1/assets/a.png?share=t">';
    expect(webAssetsInHtml(html)).toEqual([
      { url: '/api/docs/d1/assets/a.png?share=t', noteId: 'd1', filename: 'a.png', relativePath: 'assets/a.png' },
      { url: '/api/docs/d2/assets/c.webm', noteId: 'd2', filename: 'c.webm', relativePath: 'assets/c.webm' },
    ]);
  });
});

describe('the share token never leaves the asset route (T3.1s)', () => {
  it('rides only the same-origin /api/docs/:id/assets route, never a URL a note names', () => {
    vi.stubGlobal('location', { search: '?share=secret-token', origin: 'http://127.0.0.1:8850' });
    expect(toDisplaySrc('assets/pattern.png', 'd1')).toBe('/api/docs/d1/assets/pattern.png?share=secret-token');
    const named = [
      'https://evil.example/a.png',
      'http://evil.example/assets/a.png',
      '//evil.example/assets/a.png',
      'https://evil.example/api/docs/d1/assets/a.png',
      'https://evil.example/?next=assets/a.png',
      'assets/../../evil.png',
      'assets/sub/a.png',
      '/api/docs/d1/assets/a.png',
      'data:image/png;base64,AA',
    ];
    for (const src of named) {
      expect(toDisplaySrc(src, 'd1'), src).not.toContain('secret-token');
      expect(buildMediaServerUrl(src, 'd1') ?? '', src).not.toContain('secret-token');
    }
  });
});
