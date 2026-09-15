import { describe, expect, it } from 'bun:test';
import { computeETag } from '../../common/utils/etag';
import { InternalError, NotFoundError, ValidationError } from '../../common/errors';
import type { BlobService } from '../../infra/blob/blob.service';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { GroupsService } from '../groups/groups.service';
import type { ContentAudioBlobService } from './content-audio-blob.service';
import {
  contentFrameResourceEtag,
  contentSummaryEtag,
  manifestReadEtag,
} from './content-presenter';
import { ContentsReadService } from './contents-read.service';

const NOTE4_PROFILE = 'zectrix-note4-400x300-mono';
const VIRTUAL_PROFILE = 'virtual-mono-296x128';

type VariantStatus = 'pending' | 'ready' | 'failed';

interface VariantRow {
  profileId: string;
  status: VariantStatus;
  pixelFormat: string;
  frameCodec: string;
  width: number;
  height: number;
  frameEtag: string | null;
  frameSize: number | null;
  storageKey: string | null;
  lastError?: string | null;
}

interface ContentRow {
  id: string;
  groupId: string;
  sortOrder: number;
  frameName: string | null;
  contentEtag: string;
  imageEtag: string;
  audioEtag: string | null;
  imageSize: number;
  audioSize: number | null;
  audioStatus: 'none' | 'ready' | 'failed' | 'pending' | 'generating';
  audioSource: 'upload' | 'tts' | null;
  audioVoice: string | null;
  kind: 'image' | 'dynamic';
  dynamicType: string | null;
  dynamicNextRunAt: Date | null;
  dynamicRefreshDueAt: Date | null;
  dynamicConfig: unknown | null;
  dynamicData: unknown | null;
  dynamicLastRunAt: Date | null;
  audioLastError: string | null;
  audioUpdatedAt: Date | null;
  variants: VariantRow[];
}

function variant(profileId: string, overrides: Partial<VariantRow> = {}): VariantRow {
  const isVirtual = profileId === VIRTUAL_PROFILE;
  const width = isVirtual ? 296 : 400;
  const height = isVirtual ? 128 : 300;
  const frame = Buffer.alloc((width * height) / 8, isVirtual ? 0x22 : 0x11);
  return {
    profileId,
    status: 'ready',
    pixelFormat: 'mono1',
    frameCodec: 'raw_mono1_msb',
    width,
    height,
    frameEtag: computeETag(frame),
    frameSize: frame.byteLength,
    storageKey: `frames/${profileId}/group-1/content-1.img`,
    lastError: null,
    ...overrides,
  };
}

function content(overrides: Partial<ContentRow> = {}): ContentRow {
  return {
    id: 'content-1',
    groupId: 'group-1',
    sortOrder: 0,
    frameName: null,
    contentEtag: 'legacy-content-etag',
    imageEtag: 'legacy-image-etag',
    audioEtag: 'audio-etag',
    imageSize: 15_000,
    audioSize: 320,
    audioStatus: 'ready',
    audioSource: 'upload',
    audioVoice: null,
    kind: 'image',
    dynamicType: null,
    dynamicNextRunAt: null,
    dynamicRefreshDueAt: null,
    dynamicConfig: null,
    dynamicData: null,
    dynamicLastRunAt: null,
    audioLastError: null,
    audioUpdatedAt: null,
    variants: [variant(NOTE4_PROFILE), variant(VIRTUAL_PROFILE)],
    ...overrides,
  };
}

function createService(opts: {
  content?: ContentRow;
  groupOwnerUserId?: string | null;
  device?: {
    id: string;
    ownerUserId: string | null;
    selectedGroupId: string | null;
    boardId: string;
    displayProfileId: string;
    protocolVersion: number;
  };
  blobs?: Record<string, Buffer>;
  calls?: { blobStorageReads: string[]; legacyBlobReads: number };
}): ContentsReadService {
  const row = opts.content ?? content();
  const device =
    opts.device ??
    ({
      id: 'device-1',
      ownerUserId: 'user-1',
      selectedGroupId: 'group-1',
      boardId: 'zectrix-note4',
      displayProfileId: NOTE4_PROFILE,
      protocolVersion: 2,
    } as const);
  const blobs =
    opts.blobs ??
    Object.fromEntries(
      row.variants.flatMap((v) =>
        v.storageKey && v.frameSize ? [[v.storageKey, Buffer.alloc(v.frameSize, 0xaa)]] : []
      )
    );
  const prisma = {
    device: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === device.id
          ? {
              ownerUserId: device.ownerUserId,
              selectedGroupId: device.selectedGroupId,
              boardId: device.boardId,
              displayProfileId: device.displayProfileId,
              protocolVersion: device.protocolVersion,
              selectedGroup: device.selectedGroupId
                ? {
                    id: device.selectedGroupId,
                    ownerUserId: device.ownerUserId,
                    manifestEtag: 'legacy-manifest',
                  }
                : null,
            }
          : null,
    },
    group: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === 'group-1'
          ? {
              id: 'group-1',
              ownerUserId: opts.groupOwnerUserId === undefined ? 'user-1' : opts.groupOwnerUserId,
              structureEtag: 'structure-etag',
              manifestEtag: 'legacy-manifest',
              name: 'Group',
              sortOrder: 0,
              contents: [row],
            }
          : null,
    },
    content: {
      findMany: async () => [row],
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === row.id ? row : null,
    },
  };
  const blob = {
    readStorageKey: async (storageKey: string) => {
      opts.calls?.blobStorageReads.push(storageKey);
      return blobs[storageKey] ?? null;
    },
    read: async () => {
      if (opts.calls) opts.calls.legacyBlobReads += 1;
      return Buffer.from('legacy-bytes');
    },
  };
  const groups = {
    ownerGroupPosition: async () => ({ current: 1, total: 1 }),
  };
  return new ContentsReadService(
    prisma as unknown as PrismaService,
    blob as unknown as BlobService,
    groups as unknown as GroupsService,
    {} as ContentAudioBlobService
  );
}

describe('ContentsReadService profile-scoped resources', () => {
  it('serves a Note4 device manifest from the persisted profile variant with board audio', async () => {
    const note4 = variant(NOTE4_PROFILE);
    const virtual = variant(VIRTUAL_PROFILE, { frameEtag: 'virtual-etag' });
    const service = createService({ content: content({ variants: [note4, virtual] }) });

    const manifest = await service.manifest('group-1', { deviceId: 'device-1' });

    expect(manifest.display_profile.id).toBe(NOTE4_PROFILE);
    expect(manifest.contents).toHaveLength(1);
    expect(manifest.contents[0]).toMatchObject({
      image_etag: contentFrameResourceEtag(NOTE4_PROFILE, note4.frameEtag!),
      image_size: note4.frameSize,
      content_etag: contentSummaryEtag(NOTE4_PROFILE, note4.frameEtag!),
      frame: {
        profile_id: NOTE4_PROFILE,
        width: 400,
        height: 300,
        byte_length: 15_000,
      },
      audio_etag: 'audio-etag',
      audio_size: 320,
    });
    expect(manifest.contents[0]!.image_etag).toBe(
      contentFrameResourceEtag(NOTE4_PROFILE, note4.frameEtag!)
    );
    expect(manifest.group.manifest_etag).toBe(
      manifestReadEtag({
        profileId: NOTE4_PROFILE,
        groupStructureEtag: 'structure-etag',
        contents: manifest.contents,
      })
    );
    expect(manifest.manifestEtag).toBe(manifest.group.manifest_etag);
  });

  it('serves an explicit Web virtual manifest without falling back to Note4 or audio', async () => {
    const virtual = variant(VIRTUAL_PROFILE);
    const service = createService({
      content: content({
        variants: [variant(NOTE4_PROFILE), virtual],
      }),
    });

    const manifest = await service.manifest('group-1', {
      userId: 'user-1',
      displayProfileId: VIRTUAL_PROFILE,
    });

    expect(manifest.display_profile.id).toBe(VIRTUAL_PROFILE);
    expect(manifest.contents[0]).toMatchObject({
      image_etag: contentFrameResourceEtag(VIRTUAL_PROFILE, virtual.frameEtag!),
      image_size: virtual.frameSize,
      content_etag: contentSummaryEtag(VIRTUAL_PROFILE, virtual.frameEtag!),
      audio_etag: null,
      audio_size: null,
      audio_status: 'none',
      frame: {
        profile_id: VIRTUAL_PROFILE,
        width: 296,
        height: 128,
        byte_length: 4736,
      },
    });
    expect(manifest.contents[0]!.image_etag).toBe(
      contentFrameResourceEtag(VIRTUAL_PROFILE, virtual.frameEtag!)
    );
    expect(manifest.manifestEtag).not.toContain('legacy-manifest');
  });

  it('serves a device manifest from a different persisted profile without falling back to Note4', async () => {
    const virtual = variant(VIRTUAL_PROFILE);
    const service = createService({
      content: content({ variants: [variant(NOTE4_PROFILE), virtual] }),
      device: {
        id: 'device-1',
        ownerUserId: 'user-1',
        selectedGroupId: 'group-1',
        boardId: 'zectrix-note4',
        displayProfileId: VIRTUAL_PROFILE,
        protocolVersion: 2,
      },
    });

    const manifest = await service.manifest('group-1', { deviceId: 'device-1' });

    expect(manifest.display_profile.id).toBe(VIRTUAL_PROFILE);
    expect(manifest.contents[0]).toMatchObject({
      image_etag: contentFrameResourceEtag(VIRTUAL_PROFILE, virtual.frameEtag!),
      image_size: virtual.frameSize,
      frame: {
        profile_id: VIRTUAL_PROFILE,
        byte_length: 4_736,
      },
    });
  });

  it('serves an explicit Web Note4 raw frame independently from virtual frames', async () => {
    const note4 = variant(NOTE4_PROFILE);
    const virtual = variant(VIRTUAL_PROFILE);
    const note4Bytes = Buffer.alloc(note4.frameSize!, 0x33);
    const service = createService({
      content: content({ variants: [note4, virtual] }),
      blobs: {
        [note4.storageKey!]: note4Bytes,
        [virtual.storageKey!]: Buffer.alloc(virtual.frameSize!, 0x44),
      },
    });

    const frame = await service.readImage('content-1', {
      userId: 'user-1',
      displayProfileId: NOTE4_PROFILE,
    });

    expect(frame.data).toEqual(note4Bytes);
    expect(frame.etag).toBe(contentFrameResourceEtag(NOTE4_PROFILE, note4.frameEtag!));
  });

  it('marks missing profile variants unavailable without leaking another profile summary', async () => {
    const service = createService({
      content: content({ variants: [variant(NOTE4_PROFILE)] }),
    });

    const manifest = await service.manifest('group-1', {
      userId: 'user-1',
      displayProfileId: VIRTUAL_PROFILE,
    });

    expect(manifest.contents[0]).toMatchObject({
      variant_status: 'unavailable',
      image_etag: '',
      image_size: 0,
      audio_etag: null,
      frame: {
        profile_id: VIRTUAL_PROFILE,
        byte_length: 4736,
      },
    });
  });

  it('reads raw frames from the selected Web profile storage key', async () => {
    const note4 = variant(NOTE4_PROFILE);
    const virtual = variant(VIRTUAL_PROFILE);
    const virtualBytes = Buffer.alloc(virtual.frameSize!, 0x44);
    const service = createService({
      content: content({ variants: [note4, virtual] }),
      blobs: {
        [note4.storageKey!]: Buffer.alloc(note4.frameSize!, 0x11),
        [virtual.storageKey!]: virtualBytes,
      },
    });

    const frame = await service.readImage('content-1', {
      userId: 'user-1',
      displayProfileId: VIRTUAL_PROFILE,
    });

    expect(frame).toEqual({
      data: virtualBytes,
      etag: contentFrameResourceEtag(VIRTUAL_PROFILE, virtual.frameEtag!),
    });
  });

  it('rejects a device profile override instead of serving a different frame', async () => {
    const service = createService({});

    await expect(
      service.manifest('group-1', { deviceId: 'device-1', displayProfileId: VIRTUAL_PROFILE })
    ).rejects.toThrow(ValidationError);
  });

  it('keeps Web and device authorization isolation for profile reads', async () => {
    const service = createService({});

    await expect(
      service.manifest('group-1', { userId: 'other-user', displayProfileId: NOTE4_PROFILE })
    ).rejects.toThrow(NotFoundError);
    await expect(
      service.manifest('group-1', {
        deviceId: 'device-1',
        displayProfileId: NOTE4_PROFILE,
      })
    ).resolves.toMatchObject({ group: { id: 'group-1' } });

    const unboundDeviceService = createService({
      device: {
        id: 'device-1',
        ownerUserId: 'user-1',
        selectedGroupId: 'other-group',
        boardId: 'zectrix-note4',
        displayProfileId: NOTE4_PROFILE,
        protocolVersion: 2,
      },
    });
    await expect(
      unboundDeviceService.manifest('group-1', { deviceId: 'device-1' })
    ).rejects.toThrow(NotFoundError);
  });

  it('builds manifests without reading blobs or mutating render state', async () => {
    const calls = { blobStorageReads: [] as string[], legacyBlobReads: 0 };
    const service = createService({ calls });

    await service.manifest('group-1', { userId: 'user-1', displayProfileId: VIRTUAL_PROFILE });

    expect(calls).toEqual({ blobStorageReads: [], legacyBlobReads: 0 });
  });

  it('rejects corrupted variant metadata before reading frame bytes', async () => {
    const broken = variant(VIRTUAL_PROFILE, { width: 400, frameSize: 15_000 });
    const service = createService({ content: content({ variants: [broken] }) });

    await expect(
      service.readImage('content-1', { userId: 'user-1', displayProfileId: VIRTUAL_PROFILE })
    ).rejects.toThrow(InternalError);
  });

  it('returns not found for missing or failed profile variants on raw frame reads', async () => {
    const service = createService({
      content: content({
        variants: [variant(NOTE4_PROFILE), variant(VIRTUAL_PROFILE, { status: 'failed' })],
      }),
    });

    await expect(
      service.readImage('content-1', { userId: 'user-1', displayProfileId: VIRTUAL_PROFILE })
    ).rejects.toThrow(NotFoundError);
  });
});
