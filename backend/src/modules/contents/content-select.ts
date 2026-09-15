import type { Prisma } from '@prisma/client';

export const CONTENT_SELECT = {
  id: true,
  groupId: true,
  sortOrder: true,
  frameName: true,
  contentEtag: true,
  imageEtag: true,
  audioEtag: true,
  imageSize: true,
  audioSize: true,
  audioStatus: true,
  audioSource: true,
  audioVoice: true,
  kind: true,
  dynamicType: true,
  dynamicNextRunAt: true,
  dynamicRefreshDueAt: true,
  dynamicConfig: true,
  dynamicData: true,
  dynamicLastRunAt: true,
  audioLastError: true,
  audioUpdatedAt: true,
  variants: {
    select: {
      profileId: true,
      status: true,
      pixelFormat: true,
      frameCodec: true,
      width: true,
      height: true,
      frameEtag: true,
      frameSize: true,
      storageKey: true,
      lastError: true,
    },
  },
} as const satisfies Prisma.ContentSelect;

export type ContentSelectRow = Prisma.ContentGetPayload<{ select: typeof CONTENT_SELECT }>;

export function contentSelect<T extends Prisma.ContentSelect>(
  extra?: T
): typeof CONTENT_SELECT & T {
  return (extra ? { ...CONTENT_SELECT, ...extra } : CONTENT_SELECT) as typeof CONTENT_SELECT & T;
}

export function contentSelectForProfile(profileId: string): typeof CONTENT_SELECT {
  return {
    ...CONTENT_SELECT,
    variants: {
      where: { profileId },
      select: CONTENT_SELECT.variants.select,
    },
  } as unknown as typeof CONTENT_SELECT;
}
