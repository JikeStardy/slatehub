export const contentKeys = {
  group: (gid: string | undefined, profileId?: string | null) =>
    ['contents', gid, profileId ?? null] as const,
  detail: (contentId: string | undefined, profileId?: string | null) =>
    ['contents', 'detail', contentId, profileId ?? null] as const,
  image: (contentId: string, etag?: string | null, profileId?: string | null) =>
    etag === undefined
      ? (['content-image', contentId] as const)
      : (['content-image', contentId, profileId ?? null, etag] as const),
  audio: (contentId: string, etag?: string | null) =>
    etag === undefined
      ? (['content-audio', contentId] as const)
      : (['content-audio', contentId, etag] as const),
};
