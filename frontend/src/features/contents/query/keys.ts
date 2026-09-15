export const contentKeys = {
  groupRoot: (gid: string | undefined) => ['contents', gid] as const,
  group: (gid: string | undefined, profileId?: string | null) =>
    profileId ? (['contents', gid, 'profile', profileId] as const) : contentKeys.groupRoot(gid),
  detailRoot: (contentId: string | undefined) => ['contents', 'detail', contentId] as const,
  detail: (contentId: string | undefined, profileId?: string | null) =>
    profileId
      ? (['contents', 'detail', contentId, 'profile', profileId] as const)
      : contentKeys.detailRoot(contentId),
  imageRoot: (contentId: string) => ['content-image', contentId] as const,
  image: (contentId: string, etag?: string | null, profileId?: string | null) =>
    etag === undefined
      ? contentKeys.imageRoot(contentId)
      : profileId
        ? (['content-image', contentId, 'profile', profileId, 'etag', etag] as const)
        : (['content-image', contentId, 'etag', etag] as const),
  audioRoot: (contentId: string) => ['content-audio', contentId] as const,
  audio: (contentId: string, etag?: string | null) =>
    etag === undefined
      ? contentKeys.audioRoot(contentId)
      : (['content-audio', contentId, etag] as const),
};
