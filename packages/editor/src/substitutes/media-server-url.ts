// Substituted for moss's editor/utils/media-server-url.ts in the editor bundle (A§2.1). Moss plays local video from
// a loopback media server; an editor plays it from the URL its bridge issues, which answers HTTP Range requests.
import { editorAssetUrl } from '@moss-editor/registry';

const noop = () => undefined;

export const onMediaServerReady: (listener: () => void) => () => void = () => noop;

export const refreshMediaServerInfo = (): void => undefined;

export const buildMediaServerUrl = (src: string, noteId?: string | null): string | null => editorAssetUrl(src, noteId) ?? null;
