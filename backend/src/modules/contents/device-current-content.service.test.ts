import { describe, expect, it } from 'bun:test';
import { computeETag } from '../../common/utils/etag';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { DynamicContentRendererService } from '../dynamic-content/dynamic-content-renderer.service';
import { ContentReadTargetResolver } from './content-read-target-resolver';
import { DeviceCurrentContentService } from './device-current-content.service';
import { contentToSummary, manifestReadEtag } from './content-presenter';
import type { GroupsService } from '../groups/groups.service';

const NOTE4_PROFILE = 'zectrix-note4-400x300-mono';
function contentRow(
  status: 'ready' | 'pending' | 'failed' | 'missing' = 'ready',
  deviceProfileId = NOTE4_PROFILE
) {
  const note4Frame = Buffer.alloc(15_000, 0x11);
  const note4Variant = {
    profileId: NOTE4_PROFILE,
    status: status === 'missing' ? ('ready' as const) : status,
    pixelFormat: 'mono1',
    frameCodec: 'raw_mono1_msb',
    width: 400,
    height: 300,
    frameEtag: status === 'ready' ? computeETag(note4Frame) : null,
    frameSize: status === 'ready' ? note4Frame.byteLength : null,
    storageKey: status === 'ready' ? `frames/${NOTE4_PROFILE}/group-1/content-1.img` : null,
    lastError: status === 'failed' ? 'render failed' : null,
  };
  const variants =
    status === 'missing' && deviceProfileId === NOTE4_PROFILE
      ? []
      : [deviceProfileId === NOTE4_PROFILE ? note4Variant : note4Variant];
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
    variants,
  };
}

function createService(
  status: 'ready' | 'pending' | 'failed' | 'missing' = 'ready',
  deviceProfileId = NOTE4_PROFILE,
  groupPosition = { current: 1, total: 1 }
) {
  const content = contentRow(status, deviceProfileId);
  const device = {
    id: 'device-1',
    selectedGroupId: 'group-1',
    selectedGroup: { manifestEtag: 'legacy-manifest' },
    boardId: 'zectrix-note4',
    displayProfileId: deviceProfileId,
    protocolVersion: 2,
  };
  const prisma = {
    device: {
      findUnique: async () => device,
    },
    group: {
      findUnique: async () => ({
        id: 'group-1',
        ownerUserId: 'user-1',
        name: 'Group',
        sortOrder: 0,
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
  const readTargets = new ContentReadTargetResolver(
    prisma as unknown as PrismaService,
    { nodeEnv: 'test' } as never
  );
  return new DeviceCurrentContentService(
    prisma as unknown as PrismaService,
    {} as DynamicContentRendererService,
    readTargets,
    {
      ownerGroupPosition: async () => groupPosition,
    } as unknown as GroupsService
  );
}

describe('DeviceCurrentContentService profile manifest handling', () => {
  it('resolves and presents current_content with the persisted device profile manifest etag', async () => {
    const service = createService();
    const manifestEtag = await service.manifestEtagForDeviceGroup(
      {
        boardId: 'zectrix-note4',
        displayProfileId: NOTE4_PROFILE,
        protocolVersion: 2,
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
      image_size: 15_000,
      audio_etag: 'audio-etag',
      frame: {
        profile_id: NOTE4_PROFILE,
        byte_length: 15_000,
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

  it('uses the real group position in the device manifest validator', async () => {
    const service = createService('ready', NOTE4_PROFILE, { current: 2, total: 3 });
    const expected = manifestReadEtag({
      profileId: NOTE4_PROFILE,
      group: {
        id: 'group-1',
        name: 'Group',
        sort_order: 0,
        position: { current: 2, total: 3 },
      },
      groupStructureEtag: 'structure-etag',
      contents: [
        contentToSummary(contentRow('ready', NOTE4_PROFILE), {
          profile: {
            id: NOTE4_PROFILE,
            width: 400,
            height: 300,
            pixel_format: 'mono1',
            frame_codec: 'raw_mono1_msb',
            availability: ['production', 'development', 'test'],
          },
          audio: true,
          device: true,
        }),
      ],
    });

    await expect(
      service.manifestEtagForDeviceGroup(
        {
          boardId: 'zectrix-note4',
          displayProfileId: NOTE4_PROFILE,
          protocolVersion: 2,
        },
        'group-1'
      )
    ).resolves.toBe(expected);
  });

  it.each(['missing', 'pending', 'failed'] as const)(
    'returns null current_content for a %s device variant',
    async (status) => {
      const service = createService(status);
      const manifestEtag = await service.manifestEtagForDeviceGroup(
        {
          boardId: 'zectrix-note4',
          displayProfileId: NOTE4_PROFILE,
          protocolVersion: 2,
        },
        'group-1'
      );

      const request = await service.resolveCurrentContentRequest('device-1', {
        current_group: 'group-1',
        current_content_seq: 2,
        manifest_etag: manifestEtag,
      });

      expect(request ? service.currentContentForDevice(request) : null).toBeNull();
    }
  );
});
