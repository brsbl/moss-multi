// Substituted for moss's editor/utils/media-server-url.ts in the viewer bundle (A§2.1). Moss plays local video
// from a loopback media server because its asset protocol cannot seek; a viewer plays it from the URL its
// assetUrl service returns, which answers HTTP Range requests itself. No server info ever arrives.
import { viewerAssetUrl } from '@moss-viewer/registry';

const noop = () => undefined;

export const onMediaServerReady: (listener: () => void) => () => void = () => noop;

export const refreshMediaServerInfo = (): void => undefined;

export const buildMediaServerUrl = (src: string, noteId?: string | null): string | null => viewerAssetUrl(src, noteId) ?? null;
