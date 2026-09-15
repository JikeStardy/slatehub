import { describe, expect, it } from 'bun:test';
import { DASHBOARD_CUSTOM_STARTER_TEMPLATE } from 'shared';
import { computeETag } from '../../common/utils/etag';
import { InternalError } from '../../common/errors';
import { DynamicContentService } from '../dynamic-content/dynamic-content.service';
import { ContentsService } from './contents.service';
import { DeviceCurrentContentService } from './device-current-content.service';

describe('ContentsService current content refresh', () => {
  it('runs dynamic mutations for the same content id serially after failures', async () => {
    const service = new DynamicContentService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    const runMutation = (
      service as unknown as {
        runMutation: <T>(contentId: string, fn: () => Promise<T>) => Promise<T>;
      }
    ).runMutation.bind(service);
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runMutation('content-1', async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
      throw new Error('first failed');
    });
    const second = runMutation('content-1', async () => {
      events.push('second:start');
      return 'ok';
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    releaseFirst?.();
    await expect(first).rejects.toThrow('first failed');
    await expect(second).resolves.toBe('ok');
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('skips timer current-frame refresh after the device manifest changes', async () => {
    let renderCalls = 0;
    const service = new DeviceCurrentContentService(
      {
        device: {
          findUnique: async () => ({
            selectedGroupId: 'group-1',
            selectedGroup: { manifestEtag: 'new-manifest' },
          }),
        },
        content: {
          findUnique: async () => {
            throw new Error('content lookup should be skipped');
          },
        },
      } as never,
      {
        renderDynamicContent: async () => {
          renderCalls += 1;
          return { groupEtag: 'rendered-manifest' };
        },
      } as never
    );

    const result = await service.refreshCurrentContentForDeviceIfDue({
      deviceId: 'device-1',
      groupId: 'group-1',
      seq: 0,
      contentId: 'content-1',
      manifestEtag: 'old-manifest',
      content: {} as never,
    });

    expect(result).toBeNull();
    expect(renderCalls).toBe(0);
  });

  it('does not reset dashboard pushed data when only refresh interval changes', async () => {
    const currentConfig = {
      type: 'dashboard',
      template: { kind: 'custom', template: DASHBOARD_CUSTOM_STARTER_TEMPLATE },
      refresh_interval_sec: 600,
    } as const;
    const pushedData = { primary_label: '线上收入', primary_value: '999k' };
    const updateData: Record<string, unknown>[] = [];

    const service = new DynamicContentService(
      {
        content: {
          findUnique: async () => {
            return {
              id: 'content-1',
              groupId: 'group-1',
              sortOrder: 0,
              kind: 'dynamic',
              dynamicType: 'dashboard',
              dynamicConfig: currentConfig,
              dynamicData: pushedData,
            };
          },
          update: async ({ data }: { data: Record<string, unknown> }) => {
            updateData.push(data);
            return {};
          },
        },
      } as never,
      {} as never,
      {
        assertOwned: async () => undefined,
      } as never,
      {} as never,
      {
        renderDynamicContent: async () => ({
          contentId: 'content-1',
          imageEtag: 'image-etag',
          audioEtag: null,
          groupEtag: 'group-etag',
          contentEtag: 'content-etag',
          renderedAt: new Date(),
          unchanged: false,
        }),
      } as never
    );

    await service.patch('content-1', 'user-1', {
      config: { ...currentConfig, refresh_interval_sec: 1800 },
    });

    expect(updateData[0]).toMatchObject({
      dynamicConfig: { ...currentConfig, refresh_interval_sec: 1800 },
    });
    expect(updateData[0]).not.toHaveProperty('dynamicData');
  });

  it('does not reset dashboard data when dashboard template changes', async () => {
    const firstConfig = {
      type: 'dashboard',
      template: { kind: 'custom', template: DASHBOARD_CUSTOM_STARTER_TEMPLATE },
      refresh_interval_sec: 600,
    } as const;
    const secondConfig = {
      ...firstConfig,
      template: {
        kind: 'custom',
        template: { ...DASHBOARD_CUSTOM_STARTER_TEMPLATE, name: '线上看板' },
      },
    };
    const snapshots: unknown[] = [firstConfig, secondConfig];
    const updateData: Record<string, unknown>[] = [];

    const service = new DynamicContentService(
      {
        content: {
          findUnique: async () => {
            const dynamicConfig = snapshots.shift();
            return {
              id: 'content-1',
              groupId: 'group-1',
              sortOrder: 0,
              kind: 'dynamic',
              dynamicType: 'dashboard',
              dynamicConfig,
            };
          },
          update: async ({ data }: { data: Record<string, unknown> }) => {
            updateData.push(data);
            return {};
          },
        },
      } as never,
      {} as never,
      {
        assertOwned: async () => undefined,
      } as never,
      {} as never,
      {
        renderDynamicContent: async () => ({
          contentId: 'content-1',
          imageEtag: 'image-etag',
          audioEtag: null,
          groupEtag: 'group-etag',
          contentEtag: 'content-etag',
          renderedAt: new Date(),
          unchanged: false,
        }),
      } as never
    );

    await Promise.all([
      service.patch('content-1', 'user-1', { config: secondConfig }),
      service.patch('content-1', 'user-1', { config: secondConfig }),
    ]);

    expect(updateData[0]).not.toHaveProperty('dynamicData');
    expect(updateData[1]).not.toHaveProperty('dynamicData');
  });

  it('keeps patchImage response from failing on a post-update content etag reread', async () => {
    const blobWrites: string[] = [];
    let recomputeCalls = 0;
    const service = new ContentsService(
      {
        content: {
          findUnique: async () => {
            return {
              id: 'content-1',
              groupId: 'group-1',
              sortOrder: 0,
              kind: 'image',
              imageEtag: 'old-image',
              audioEtag: null,
              audioSource: null,
            };
          },
        },
        contentSource: {
          findUnique: async () => null,
        },
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            $queryRaw: async () => [{ id: 'group-1' }],
            content: {
              findUnique: async () => ({
                groupId: 'group-1',
                kind: 'image',
                audioEtag: null,
              }),
              update: async () => ({
                imageEtag: 'new-image',
                audioEtag: null,
                contentEtag: 'updated-content-etag',
              }),
            },
            contentSource: {
              upsert: async () => ({}),
            },
          }),
      } as never,
      {
        read: async () => Buffer.from('old-image'),
        write: async (_gid: string, id: string) => {
          blobWrites.push(id);
          return { path: id, size: 1 };
        },
        writeStorageKey: async () => ({ path: 'source', size: 1 }),
        readStorageKey: async (key: string) =>
          key.includes('zectrix-note4-400x300-mono') ? Buffer.from([0xff]) : null,
        deleteStorageKey: async () => undefined,
        sourceKey: () => 'sources/group-1/content-1.source',
        frameKey: () => 'frames/zectrix-note4-400x300-mono/group-1/content-1.img',
      } as never,
      {
        assertOwned: async () => undefined,
        recomputeManifestEtag: async (_gid: string, tx?: unknown) => {
          expect(tx).toBeDefined();
          recomputeCalls += 1;
          return 'group-etag';
        },
      } as never,
      {
        renderTo1bpp: async () => ({ data: Buffer.from([0xff]), width: 8, height: 1 }),
        validateFrameSize: () => undefined,
      } as never,
      {} as never,
      {} as never,
      { read: async () => null, delete: async () => undefined } as never,
      {
        renderContentVariants: async () => ({
          results: [
            {
              profileId: 'zectrix-note4-400x300-mono',
              status: 'ready',
              changed: true,
              frameEtag: 'new-image',
              frameSize: 1,
              storageKey: 'frames/zectrix-note4-400x300-mono/group-1/content-1.img',
            },
          ],
        }),
      } as never
    );

    const response = await service.patchImage('content-1', 'user-1', {
      hasImage: true,
      imageBuf: Buffer.from('image'),
      hasAudio: false,
      audioBuf: null,
      hasFrameName: false,
      frameName: null,
    });

    expect(response.content_etag).toBe('updated-content-etag');
    expect(recomputeCalls).toBe(2);
    expect(blobWrites).toEqual(['content-1']);
  });

  it('does not delete the current audio blob when uploaded audio etag is unchanged', async () => {
    const audioBytes = Buffer.from('same-audio');
    const audioEtag = computeETag(audioBytes);
    const audioDeletes: Array<string | null> = [];
    const service = new ContentsService(
      {
        content: {
          findUnique: async () => ({
            id: 'content-1',
            groupId: 'group-1',
            sortOrder: 0,
            kind: 'image',
            imageEtag: 'image-etag',
            audioEtag,
            audioSource: 'upload',
          }),
        },
        contentSource: {
          findUnique: async () => null,
        },
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            $queryRaw: async () => [{ id: 'group-1' }],
            content: {
              findUnique: async () => ({
                groupId: 'group-1',
                kind: 'image',
                audioEtag,
              }),
              update: async () => ({
                imageEtag: 'image-etag',
                audioEtag,
                contentEtag: 'updated-content-etag',
              }),
            },
          }),
      } as never,
      {
        write: async () => ({ path: 'audio', size: audioBytes.byteLength }),
        delete: async () => undefined,
      } as never,
      {
        assertOwned: async () => undefined,
        recomputeManifestEtag: async () => 'group-etag',
      } as never,
      {} as never,
      {
        transcodeAudio: async () => audioBytes,
      } as never,
      {} as never,
      {} as never,
      {
        read: async () => audioBytes,
        delete: async (_gid: string, _contentId: string, etag: string | null) => {
          audioDeletes.push(etag);
        },
      } as never
    );

    const response = await service.patchImage('content-1', 'user-1', {
      hasImage: false,
      imageBuf: null,
      hasAudio: true,
      audioBuf: audioBytes,
      hasFrameName: false,
      frameName: null,
    });

    expect(response.audio_etag).toBe(audioEtag);
    expect(audioDeletes).toEqual([]);
  });

  it('does not fail a committed patchImage when stale audio cleanup fails', async () => {
    const audioDeletes: Array<string | null> = [];
    const service = new ContentsService(
      {
        content: {
          findUnique: async () => ({
            id: 'content-1',
            groupId: 'group-1',
            sortOrder: 0,
            kind: 'image',
            imageEtag: 'old-image',
            audioEtag: 'old-audio',
            audioSource: 'upload',
          }),
        },
        contentSource: {
          findUnique: async () => null,
        },
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            $queryRaw: async () => [{ id: 'group-1' }],
            content: {
              findUnique: async () => ({
                groupId: 'group-1',
                kind: 'image',
                audioEtag: 'old-audio',
              }),
              update: async () => ({
                imageEtag: 'new-image',
                audioEtag: null,
                contentEtag: 'updated-content-etag',
              }),
            },
            contentSource: {
              upsert: async () => ({}),
            },
          }),
      } as never,
      {
        read: async () => Buffer.from('old-image'),
        write: async () => ({ path: 'image', size: 1 }),
        writeStorageKey: async () => ({ path: 'source', size: 1 }),
        readStorageKey: async (key: string) =>
          key.includes('zectrix-note4-400x300-mono') ? Buffer.from([0xff]) : null,
        deleteStorageKey: async () => undefined,
        sourceKey: () => 'sources/group-1/content-1.source',
        frameKey: () => 'frames/zectrix-note4-400x300-mono/group-1/content-1.img',
      } as never,
      {
        assertOwned: async () => undefined,
        recomputeManifestEtag: async () => 'group-etag',
      } as never,
      {
        renderTo1bpp: async () => ({ data: Buffer.from([0xff]), width: 8, height: 1 }),
        validateFrameSize: () => undefined,
      } as never,
      {} as never,
      {} as never,
      {
        read: async () => null,
        delete: async (_gid: string, _contentId: string, etag: string | null) => {
          audioDeletes.push(etag);
          throw new Error('unlink failed');
        },
      } as never,
      {
        renderContentVariants: async () => ({
          results: [
            {
              profileId: 'zectrix-note4-400x300-mono',
              status: 'ready',
              changed: true,
              frameEtag: 'new-image',
              frameSize: 1,
              storageKey: 'frames/zectrix-note4-400x300-mono/group-1/content-1.img',
            },
          ],
        }),
      } as never
    );

    const response = await service.patchImage('content-1', 'user-1', {
      hasImage: true,
      imageBuf: Buffer.from('image'),
      hasAudio: false,
      audioBuf: null,
      hasFrameName: false,
      frameName: null,
    });

    expect(response).toMatchObject({
      content_etag: 'updated-content-etag',
      audio_etag: null,
      manifest_etag: 'group-etag',
    });
    expect(audioDeletes).toEqual(['old-audio']);
  });

  it('updates image frame names and recomputes etags inside the same transaction', async () => {
    const calls: string[] = [];
    const service = new ContentsService(
      {
        content: {
          findUnique: async () => ({
            id: 'content-1',
            groupId: 'group-1',
            sortOrder: 0,
            kind: 'image',
            imageEtag: 'image-etag',
            audioEtag: null,
            audioSource: null,
          }),
        },
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            $queryRaw: async () => {
              calls.push('lock');
              return [{ id: 'group-1' }];
            },
            content: {
              update: async ({ data }: { data: { frameName: string } }) => {
                calls.push(`update:${data.frameName}`);
                return { contentEtag: 'content-etag' };
              },
            },
          }),
      } as never,
      {} as never,
      {
        assertOwned: async () => undefined,
        recomputeManifestEtag: async (_gid: string, tx?: unknown) => {
          expect(tx).toBeDefined();
          calls.push('recompute');
          return 'group-etag';
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    const response = await service.patchFrameName('content-1', 'user-1', '新标题');

    expect(response).toMatchObject({
      content_etag: 'content-etag',
      image_etag: 'image-etag',
      manifest_etag: 'group-etag',
    });
    expect(calls).toEqual(['lock', 'update:新标题', 'recompute']);
  });

  it('reports both render and rollback errors when appendDynamic rollback fails', async () => {
    let transactionCalls = 0;
    const service = new DynamicContentService(
      {
        content: {
          findUnique: async () => ({ audioEtag: null }),
        },
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
          transactionCalls += 1;
          if (transactionCalls === 1) {
            return fn({
              $queryRaw: async () => [{ id: 'group-1' }],
              content: {
                findFirst: async () => null,
                create: async () => ({}),
              },
            });
          }
          throw new Error('rollback database unavailable');
        },
      } as never,
      {} as never,
      {
        assertOwned: async () => undefined,
        recomputeManifestEtag: async () => 'group-etag',
      } as never,
      {
        get: () => ({ provider: {} }),
      } as never,
      {
        renderDynamicContent: async () => {
          throw new Error('render network timeout');
        },
      } as never
    );

    try {
      await service.append('group-1', 'user-1', {
        frame_name: null,
        config: {
          type: 'dashboard',
          template: { kind: 'system', id: 'ai_usage_stats' },
        },
        initial_data: { total_requests: 1 },
      });
      throw new Error('expected appendDynamic to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(InternalError);
      expect((err as InternalError).detail).toMatchObject({
        code: 'dynamic_create_rollback_failed',
        original_error: 'render network timeout',
        rollback_error: 'rollback database unavailable',
      });
    }
  });
});
