// ported-from: packages/desktop/src/renderer/editor/utils/video-url.ts @ 762abb777
/**
 * YouTube URL parsing and video source detection utilities.
 */

const YOUTUBE_REGEX = /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})(?:[?&#].*)?$/;
const LOCAL_VIDEO_EXTENSIONS = /\.(?:mp4|webm|mov)(?=$|[?#])/i;

export function extractYouTubeVideoId(url: string): string | null {
  const match = url.trim().match(YOUTUBE_REGEX);
  return match?.[1] ?? null;
}

export function isYouTubeUrl(text: string): boolean {
  return YOUTUBE_REGEX.test(text.trim());
}

export function isLocalVideoPath(text: string): boolean {
  return LOCAL_VIDEO_EXTENSIONS.test(text.trim());
}

export function buildYouTubeThumbnailUrls(videoId: string): string[] {
  return [
    `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
  ];
}

export function buildYouTubeThumbnailUrl(videoId: string): string {
  return buildYouTubeThumbnailUrls(videoId)[0];
}

export function buildYouTubeEmbedUrl(videoId: string): string {
  return `https://www.youtube.com/embed/${videoId}?autoplay=1`;
}
