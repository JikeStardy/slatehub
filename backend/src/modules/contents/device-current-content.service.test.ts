import { describe, expect, it } from 'bun:test';
import { computeETag } from '../../common/utils/etag';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { DynamicContentRendererService } from '../dynamic-content/dynamic-content-renderer.service';
import { DeviceCurrentContentService } from './device-current-content.service';

const NOTE4_PROFILE = 'zectrix-note4-400x300-mono';
const VIRTUAL_PROFILE = 'virtual-mono-296x128';

function contentRow() {
  const note4Frame = Buffer.alloc(15_000, 0x11);
  const virtualFrame = Buffer.alloc(4_736, 0x22);
  return {
    id: 'content-1',
    groupId: 'group-1',
    sortOrder: 2,
    frameName: 'Frame',
    contentEtag: 'legacy-content',
    imageEtag: 'legacy-image',
    audioEtag: 'audio-etag',
    imageSize: 15_000,
    audioSize: 320,
    audioStatus: 'ready' as const,
    audioSource: 'upload' as const,
    audioVoice: null,
    kind: 'image' as const,
    dynamicType: null,
    dynamicNextRunAt: null,
    dynamicRefreshDueAt: null,
    dynamicConfig: null,
    dynamicData: null,
    dynamicLastRunAt: null,
    audioLastError: null,
    audioUpdatedAt: null,
    variants: [
      {
        profileId: NOTE4_PROFILE,
        status: 'ready' as const,
        pixelFormat: 'mono1',
        frameCodec: 'raw_mono1_msb',
        width: 400,
        height: 300,
        frameEtag: computeETag(note4Frame),
        frameSize: note4Frame.byteLength,
        storageKey: `frames/${NOTE4_PROFILE}/group-1/content-1.img`,
        lastError: null,
      },
      {
        profileId: VIRTUAL_PROFILE,
        status: 'ready' as const,
        pixelFormat: 'mono1',
        frameCodec: 'raw_mono1_msb',
        width: 296,
        height: 128,
        frameEtag: computeETag(virtualFrame),
        frameSize: virtualFrame.byteLength,
        storageKey: `frames/${VIRTUAL_PROFILE}/group-1/content-1.img`,
        lastError: null,
      },
    ],
  };
}

function createService() {
  const content = contentRow();
  const device = {
    id: 'device-1',
    selectedGroupId: 'group-1',
    selectedGroup: { manifestEtag: 'legacy-manifest' },
    boardId: 'zectrix-note4',
    displayProfileId: VIRTUAL_PROFILE,
    protocolVersion: 2,
  };
  const prisma = {
    device: {
      findUnique: async () => device,
    },
    group: {
      findUnique: async () => ({
        structureEtag: 'structure-etag',
        contents: [content],
      }),
    },
    content: {
      findUnique: async ({
        where,
      }: {
        where: { groupId_sortOrder?: { groupId: string; sortOrder: number } };
      }) =>
        where.groupId_sortOrder?.groupId === 'group-1' && where.groupId_sortOrder.sortOrder === 2
          ? content
          : null,
    },
  };
  return new DeviceCurrentContentService(
    prisma as unknown as PrismaService,
    {} as DynamicContentRendererService
  );
}

describe('DeviceCurrentContentService profile manifest handling', () => {
  it('resolves and presents current_content with the persisted device profile manifest etag', async () => {
    const service = createService();
    const manifestEtag = await service.manifestEtagForDeviceGroup(
      {
        boardId: 'zectrix-note4',
        displayProfileId: VIRTUAL_PROFILE,
      },
      'group-1'
    );

    const request = await service.resolveCurrentContentRequest('device-1', {
      current_group: 'group-1',
      current_content_seq: 2,
      manifest_etag: manifestEtag,
    });
    const summary = request ? service.currentContentForDevice(request) : null;

    expect(request?.manifestEtag).toBe(manifestEtag);
    expect(summary).toMatchObject({
      id: 'content-1',
      image_size: 4_736,
      audio_etag: 'audio-etag',
      frame: {
        profile_id: VIRTUAL_PROFILE,
        byte_length: 4_736,
      },
    });
  });

  it('does not resolve current_content when telemetry sends the legacy global manifest etag', async () => {
    const service = createService();

    const request = await service.resolveCurrentContentRequest('device-1', {
      current_group: 'group-1',
      current_content_seq: 2,
      manifest_etag: 'legacy-manifest',
    });

    expect(request).toBeNull();
  });
});
