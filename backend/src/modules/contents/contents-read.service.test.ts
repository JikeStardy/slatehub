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
import { ContentReadTargetResolver } from './content-read-target-resolver';
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
  contents?: ContentRow[];
  groupOwnerUserId?: string | null;
  nodeEnv?: 'development' | 'production' | 'test';
  device?: {
    id: string;
    ownerUserId: string | null;
    selectedGroupId: string | null;
    boardId: string;
    displayProfileId: string;
    protocolVersion: number;
  };
  blobs?: Record<string, Buffer>;
  audioBlob?: Buffer | null;
  calls?: { blobStorageReads: string[]; legacyBlobReads: number; audioRepairs?: number };
}): ContentsReadService {
  const row = opts.content ?? content();
  const rows = opts.contents ?? [row];
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
              contents: rows,
            }
          : null,
    },
    content: {
      findMany: async () => rows,
      findUnique: async ({ where }: { where: { id: string } }) =>
        rows.find((candidate) => candidate.id === where.id) ?? null,
    },
  };
  const blob = {
    frameKey: (groupId: string, contentId: string, profileId: string) =>
      `frames/${profileId}/${groupId}/${contentId}.img`,
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
  const audioBlobs = {
    read: async () => opts.audioBlob ?? null,
    repairMissingAudioBlob: async () => {
      if (opts.calls) opts.calls.audioRepairs = (opts.calls.audioRepairs ?? 0) + 1;
    },
  };
  const readTargets = new ContentReadTargetResolver(
    prisma as unknown as PrismaService,
    { nodeEnv: opts.nodeEnv ?? 'test' } as never
  );
  return new ContentsReadService(
    prisma as unknown as PrismaService,
    blob as unknown as BlobService,
    groups as unknown as GroupsService,
    audioBlobs as unknown as ContentAudioBlobService,
    readTargets
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
        group: {
          id: 'group-1',
          name: 'Group',
          sort_order: 0,
          position: { current: 1, total: 1 },
        },
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

  it('rejects a device whose persisted profile does not match its board', async () => {
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

    await expect(service.manifest('group-1', { deviceId: 'device-1' })).rejects.toThrow(
      ValidationError
    );
  });

  it('rejects device reads for unsupported persisted protocol versions', async () => {
    const service = createService({
      device: {
        id: 'device-1',
        ownerUserId: 'user-1',
        selectedGroupId: 'group-1',
        boardId: 'zectrix-note4',
        displayProfileId: NOTE4_PROFILE,
        protocolVersion: 7,
      },
    });

    await expect(service.manifest('group-1', { deviceId: 'device-1' })).rejects.toThrow(
      ValidationError
    );
  });

  it('rejects device reads for unknown persisted board ids with validation errors', async () => {
    const service = createService({
      device: {
        id: 'device-1',
        ownerUserId: 'user-1',
        selectedGroupId: 'group-1',
        boardId: 'unknown-board',
        displayProfileId: NOTE4_PROFILE,
        protocolVersion: 2,
      },
    });

    await expect(service.manifest('group-1', { deviceId: 'device-1' })).rejects.toThrow(
      ValidationError
    );
  });

  it('serves an explicit Web Note4 raw frame independently from virtual frames', async () => {
    const note4Bytes = Buffer.alloc(15_000, 0x33);
    const note4 = variant(NOTE4_PROFILE, {
      frameEtag: computeETag(note4Bytes),
      frameSize: note4Bytes.byteLength,
    });
    const virtual = variant(VIRTUAL_PROFILE);
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

  it('omits non-ready variants from device manifests instead of sending unavailable placeholders', async () => {
    const service = createService({
      content: content({
        variants: [variant(NOTE4_PROFILE, { status: 'pending', frameEtag: null })],
      }),
    });

    const manifest = await service.manifest('group-1', { deviceId: 'device-1' });

    expect(manifest.contents).toEqual([]);
  });

  it('renumbers device manifest seq over the playable ready projection while Web keeps DB order', async () => {
    const service = createService({
      contents: [
        content({ id: 'content-1', sortOrder: 0, frameName: 'First' }),
        content({
          id: 'content-2',
          sortOrder: 1,
          frameName: 'Pending',
          variants: [variant(NOTE4_PROFILE, { status: 'pending', frameEtag: null })],
        }),
        content({ id: 'content-3', sortOrder: 2, frameName: 'Third' }),
      ],
    });

    const deviceManifest = await service.manifest('group-1', { deviceId: 'device-1' });
    const webManifest = await service.manifest('group-1', { userId: 'user-1' });

    expect(deviceManifest.contents.map((item) => [item.id, item.seq])).toEqual([
      ['content-1', 0],
      ['content-3', 1],
    ]);
    expect(webManifest.contents.map((item) => [item.id, item.seq, item.variant_status])).toEqual([
      ['content-1', 0, 'ready'],
      ['content-2', 1, 'pending'],
      ['content-3', 2, 'ready'],
    ]);
  });

  it('reads raw frames from the selected Web profile storage key', async () => {
    const note4 = variant(NOTE4_PROFILE);
    const virtualBytes = Buffer.alloc(4_736, 0x44);
    const virtual = variant(VIRTUAL_PROFILE, {
      frameEtag: computeETag(virtualBytes),
      frameSize: virtualBytes.byteLength,
    });
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

  it('rejects ready variants stored under the wrong group content or profile key', async () => {
    const note4 = variant(NOTE4_PROFILE, {
      storageKey: `frames/${NOTE4_PROFILE}/other-group/content-1.img`,
    });
    const service = createService({
      content: content({ variants: [note4] }),
      blobs: { [note4.storageKey!]: Buffer.alloc(note4.frameSize!, 0x11) },
    });

    await expect(
      service.readImage('content-1', { userId: 'user-1', displayProfileId: NOTE4_PROFILE })
    ).rejects.toThrow(InternalError);
  });

  it('keeps the migrated Note4 legacy storage key as the only non-canonical frame exception', async () => {
    const bytes = Buffer.alloc(15_000, 0x11);
    const note4 = variant(NOTE4_PROFILE, {
      storageKey: 'group-1/content-1.img',
      frameEtag: computeETag(bytes),
      frameSize: bytes.byteLength,
    });
    const service = createService({
      content: content({ variants: [note4] }),
      blobs: { [note4.storageKey!]: bytes },
    });

    await expect(
      service.readImage('content-1', { userId: 'user-1', displayProfileId: NOTE4_PROFILE })
    ).resolves.toMatchObject({
      data: bytes,
      etag: contentFrameResourceEtag(NOTE4_PROFILE, note4.frameEtag!),
    });
  });

  it('rejects dynamic candidate frame keys whose attempt token is not a UUID', async () => {
    const note4 = variant(NOTE4_PROFILE, {
      storageKey: `frames/${NOTE4_PROFILE}/group-1/content-1.not-a-uuid.img`,
    });
    const service = createService({
      content: content({ variants: [note4] }),
      blobs: { [note4.storageKey!]: Buffer.alloc(note4.frameSize!, 0x11) },
    });

    await expect(
      service.readImage('content-1', { userId: 'user-1', displayProfileId: NOTE4_PROFILE })
    ).rejects.toThrow(InternalError);
  });

  it('rejects same-size frame bytes whose digest does not match variant metadata', async () => {
    const note4 = variant(NOTE4_PROFILE, {
      frameEtag: computeETag(Buffer.alloc(15_000, 0x11)),
      frameSize: 15_000,
    });
    const service = createService({
      content: content({ variants: [note4] }),
      blobs: { [note4.storageKey!]: Buffer.alloc(15_000, 0x12) },
    });

    await expect(
      service.readImage('content-1', { userId: 'user-1', displayProfileId: NOTE4_PROFILE })
    ).rejects.toThrow(InternalError);
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

  it('uses the requested Web profile for list details', async () => {
    const virtual = variant(VIRTUAL_PROFILE);
    const service = createService({
      content: content({ variants: [variant(NOTE4_PROFILE), virtual] }),
    });

    const rows = await service.list('group-1', {
      userId: 'user-1',
      displayProfileId: VIRTUAL_PROFILE,
    });

    expect(rows[0]).toMatchObject({
      image_etag: contentFrameResourceEtag(VIRTUAL_PROFILE, virtual.frameEtag!),
      audio_etag: null,
      frame: {
        profile_id: VIRTUAL_PROFILE,
        byte_length: 4_736,
      },
    });
  });

  it('treats omitted Web profile and explicit Note4 as equivalent board-capability reads', async () => {
    const service = createService({});

    const omitted = await service.manifest('group-1', { userId: 'user-1' });
    const explicit = await service.manifest('group-1', {
      userId: 'user-1',
      displayProfileId: NOTE4_PROFILE,
    });

    expect(omitted.contents[0]?.audio_etag).toBe('audio-etag');
    expect(explicit.contents[0]?.audio_etag).toBe('audio-etag');
    expect(explicit.contents[0]?.image_etag).toBe(omitted.contents[0]?.image_etag);
  });

  it('rejects production Web requests for development-only virtual profiles', async () => {
    const service = createService({ nodeEnv: 'production' });

    await expect(
      service.manifest('group-1', { userId: 'user-1', displayProfileId: VIRTUAL_PROFILE })
    ).rejects.toThrow(ValidationError);
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

  it('returns not found for missing audio blobs without repairing rows during GET', async () => {
    const calls = { blobStorageReads: [] as string[], legacyBlobReads: 0, audioRepairs: 0 };
    const service = createService({ calls, audioBlob: null });

    await expect(service.readAudio('content-1', { userId: 'user-1' })).rejects.toThrow(
      NotFoundError
    );
    expect(calls.audioRepairs).toBe(0);
  });

  it('reads audio for default Web and Note4 device targets', async () => {
    const audioBlob = Buffer.from('audio bytes');
    const service = createService({ audioBlob });

    await expect(service.readAudio('content-1', { userId: 'user-1' })).resolves.toEqual({
      data: audioBlob,
      etag: 'audio-etag',
    });
    await expect(service.readAudio('content-1', { deviceId: 'device-1' })).resolves.toEqual({
      data: audioBlob,
      etag: 'audio-etag',
    });
  });

  it('rejects audio reads for targets whose display profile has no audio capability', async () => {
    const calls = { blobStorageReads: [] as string[], legacyBlobReads: 0, audioRepairs: 0 };
    const service = createService({ calls, audioBlob: Buffer.from('audio bytes') });

    await expect(
      service.readAudio('content-1', { userId: 'user-1', displayProfileId: VIRTUAL_PROFILE })
    ).rejects.toThrow(NotFoundError);
    expect(calls.audioRepairs).toBe(0);
  });
});
