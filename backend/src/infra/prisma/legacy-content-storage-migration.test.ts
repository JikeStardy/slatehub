import { describe, expect, it } from 'bun:test';
import { projectLegacyContentStorageMigration } from './legacy-content-storage-migration';

describe('projectLegacyContentStorageMigration', () => {
  it('projects seeded devices and image/dynamic contents into the complete legacy backfill', () => {
    const imageCreatedAt = new Date('2026-01-02T03:04:05.000Z');
    const imageUpdatedAt = new Date('2026-02-03T04:05:06.000Z');
    const dynamicCreatedAt = new Date('2026-03-04T05:06:07.000Z');
    const dynamicUpdatedAt = new Date('2026-04-05T06:07:08.000Z');

    const result = projectLegacyContentStorageMigration({
      devices: [{ id: 'device-1' }, { id: 'device-2' }],
      contents: [
        {
          id: 'image-1',
          groupId: 'group-a',
          kind: 'image',
          imageEtag: 'image-etag',
          imageSize: 15_000,
          createdAt: imageCreatedAt,
          updatedAt: imageUpdatedAt,
        },
        {
          id: 'dynamic-1',
          groupId: 'group-b',
          kind: 'dynamic',
          imageEtag: 'dynamic-etag',
          imageSize: 15_000,
          createdAt: dynamicCreatedAt,
          updatedAt: dynamicUpdatedAt,
        },
      ],
    });

    expect(result.devices).toHaveLength(2);
    expect(result.devices).toEqual([
      {
        id: 'device-1',
        boardId: 'zectrix-note4',
        displayProfileId: 'zectrix-note4-400x300-mono',
        protocolVersion: 2,
      },
      {
        id: 'device-2',
        boardId: 'zectrix-note4',
        displayProfileId: 'zectrix-note4-400x300-mono',
        protocolVersion: 2,
      },
    ]);

    expect(result.sources).toHaveLength(1);
    expect(result.sources).toEqual([
      {
        contentId: 'image-1',
        status: 'unavailable',
        sourceEtag: null,
        mimeType: null,
        size: null,
        storageKey: null,
        createdAt: imageCreatedAt,
        updatedAt: imageUpdatedAt,
      },
    ]);

    expect(result.variants).toHaveLength(2);
    expect(result.variants).toEqual([
      {
        id: 'image-1',
        contentId: 'image-1',
        profileId: 'zectrix-note4-400x300-mono',
        status: 'ready',
        pixelFormat: 'mono1',
        frameCodec: 'raw_mono1_msb',
        width: 400,
        height: 300,
        frameEtag: 'image-etag',
        frameSize: 15_000,
        storageKey: 'group-a/image-1.img',
        renderVersion: 1,
        lastError: null,
        leaseUntil: null,
        attempts: 0,
        createdAt: imageCreatedAt,
        updatedAt: imageUpdatedAt,
      },
      {
        id: 'dynamic-1',
        contentId: 'dynamic-1',
        profileId: 'zectrix-note4-400x300-mono',
        status: 'ready',
        pixelFormat: 'mono1',
        frameCodec: 'raw_mono1_msb',
        width: 400,
        height: 300,
        frameEtag: 'dynamic-etag',
        frameSize: 15_000,
        storageKey: 'group-b/dynamic-1.img',
        renderVersion: 1,
        lastError: null,
        leaseUntil: null,
        attempts: 0,
        createdAt: dynamicCreatedAt,
        updatedAt: dynamicUpdatedAt,
      },
    ]);
  });
});
