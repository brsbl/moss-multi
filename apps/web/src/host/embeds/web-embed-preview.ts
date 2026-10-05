// The web `webEmbedPreview` namespace (A§9; A§16): moss's web-embed cards and pill hover cards ask `ensure` for a
// page's preview, which the Worker unfurls (`POST /api/unfurl`) and this turns into moss's own preview result. The
// card's image and site icon are https URLs the page itself loads; a failed or refused unfurl is null, so moss shows
// its URL card. One answer per note and URL for the life of the tab, unless moss forces a refresh.
import {
  createWebEmbedFallbackMetadata,
  createWebEmbedPreviewResult,
  getWebEmbedPreviewDescriptor,
  type WebEmbedPreviewMetadata,
  type WebEmbedPreviewResult,
} from '@moss-desktop/common/web-embed-preview';

/** What the Worker answers (apps/web/src/api/unfurl.ts). */
interface Unfurled {
  status: 'resolved' | 'fallback';
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
  icon?: string;
  themeColor?: string;
  canonicalUrl?: string;
}

type Send = (path: string, init?: RequestInit) => Promise<Response>;

export function createWebEmbedPreviewApi(request: Send) {
  const answers = new Map<string, Promise<WebEmbedPreviewResult | null>>();

  const unfurl = async (noteId: string, url: string): Promise<WebEmbedPreviewResult | null> => {
    const descriptor = getWebEmbedPreviewDescriptor(url);
    if (!descriptor) return null;
    const response = await request('/api/unfurl', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ noteId, url: descriptor.normalizedUrl }),
    });
    if (!response.ok) return null;
    const card = (await response.json()) as Unfurled;
    const extras: WebEmbedPreviewMetadata = {};
    const found: Record<string, string | undefined> = {
      title: card.title,
      description: card.description,
      providerName: card.siteName,
      themeColor: card.themeColor,
      canonicalUrl: card.canonicalUrl,
      siteIconAssetRelativePath: card.icon,
    };
    for (const [key, value] of Object.entries(found)) if (value) extras[key] = value;
    return createWebEmbedPreviewResult({
      descriptor,
      status: card.status,
      assetRelativePath: card.image,
      metadata: createWebEmbedFallbackMetadata(descriptor.normalizedUrl, extras),
      generatedAt: new Date().toISOString(),
    });
  };

  return {
    ensure: (input: { noteId: string; url: string; force?: boolean }): Promise<WebEmbedPreviewResult | null> => {
      const key = `${input.noteId}\u0000${input.url}`;
      const known = answers.get(key);
      if (known && !input.force) return known;
      const pending = unfurl(input.noteId, input.url).catch(() => null);
      answers.set(key, pending);
      // A failed unfurl is asked again the next time moss shows the card.
      void pending.then((result) => {
        if (!result && answers.get(key) === pending) answers.delete(key);
      });
      return pending;
    },
    /** Answers come back from `ensure`; nothing is pushed later. */
    subscribe: (_callback?: unknown) => () => undefined,
  };
}
