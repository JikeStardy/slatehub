import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FRAME_BYTES } from 'shared';
import { computeETag } from '../../common/utils/etag';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import { BlobService } from '../../infra/blob/blob.service';
import { audioBlobContentId } from '../../infra/blob/content-audio-blobs';
import type { AppConfig } from '../../infra/config/app.config';
import type { GroupsService } from '../groups/groups.service';
import { ContentsService } from '../contents/contents.service';
import type { DynamicFrameRendererService } from './rendering/dynamic-frame-renderer.service';
import type { DynamicAudioService } from './audio/dynamic-audio.service';
import type { DynamicContentRegistry } from './dynamic-content-registry';
import { DynamicContentRendererService } from './dynamic-content-renderer.service';
import { VariantRenderService } from '../rendering/variant-render.service';
import {
  NOTE4_RENDER_TARGET,
  renderTargetForProfile,
  type RenderTarget,
} from '../rendering/render-target';

const VIRTUAL_RENDER_TARGET = renderTargetForProfile('virtual-mono-296x128');

let blobDir = '/tmp/slate-dynamic-render-test';

beforeEach(async () => {
  blobDir = await mkdtemp(join(tmpdir(), 'slate-dynamic-render-test-'));
});

afterEach(async () => {
  await rm(blobDir, { recursive: true, force: true });
});

describe('DynamicContentRendererService queueing', () => {
  it('does not run a scheduled render queued behind a failed force render', async () => {
    const first = deferred<unknown>();
    let fetchCalls = 0;
    const service = createService({
      fetchData: () => {
        fetchCalls++;
        return first.promise;
      },
    });

    const forceRender = service.renderDynamicContent('content-1', { force: true });
    const scheduledRender = service.renderDynamicContent('content-1');

    first.reject(new Error('provider down'));

    await expect(forceRender).rejects.toThrow('provider down');
    await expect(scheduledRender).rejects.toThrow('provider down');
    expect(fetchCalls).toBe(1);
  });

  it('still runs a force render queued behind a failed force render', async () => {
    const first = deferred<unknown>();
    let fetchCalls = 0;
    const service = createService({
      fetchData: () => {
        fetchCalls++;
        if (fetchCalls === 1) return first.promise;
        return Promise.resolve({ tempC: 21 });
      },
    });

    const failedRender = service.renderDynamicContent('content-1', { force: true });
    const forceRender = service.renderDynamicContent('content-1', { force: true });

    first.reject(new Error('provider down'));

    await expect(failedRender).rejects.toThrow('provider down');
    await expect(forceRender).resolves.toMatchObject({
      contentId: 'content-1',
      groupEtag: 'group-etag',
      unchanged: false,
    });
    expect(fetchCalls).toBe(2);
  });

  it('rejects non-object render data instead of silently rendering empty fields', async () => {
    const service = createService({ fetchData: () => Promise.resolve(['not', 'an', 'object']) });

    await expect(service.renderDynamicContent('content-1', { force: true })).rejects.toThrow(
      '动态数据必须是 JSON 对象或 null'
    );
  });

  it('keeps a successful render response when dynamic audio sync fails', async () => {
    const service = createService({
      fetchData: () => Promise.resolve({ tempC: 21 }),
      syncAudio: async () => {
        throw new Error('audio cleanup failed');
      },
    });

    await expect(service.renderDynamicContent('content-1', { force: true })).resolves.toMatchObject(
      {
        contentId: 'content-1',
        imageEtag: expect.any(String),
        audioEtag: null,
        groupEtag: 'group-etag',
        unchanged: false,
      }
    );
  });

  it('does not reuse stale time-sensitive dynamic data after fetch failure', async () => {
    const service = createService({
      fetchData: () => Promise.reject(new Error('provider down')),
      imageSize: FRAME_BYTES,
      dynamicData: {
        tempC: 21,
        summary: '晴',
        updatedAt: '2026-05-17T00:00:00.000Z',
      },
      dynamicLastRunAt: new Date('2026-05-17T00:00:00.000Z'),
    });

    await expect(
      service.renderDynamicContent('content-1', {
        force: true,
        now: new Date('2026-05-18T00:00:00.000Z'),
      })
    ).rejects.toThrow('provider down');
  });

  it('reuses fresh time-sensitive dynamic data after fetch failure', async () => {
    const service = createService({
      fetchData: () => Promise.reject(new Error('provider down')),
      imageSize: FRAME_BYTES,
      dynamicData: {
        tempC: 21,
        summary: '晴',
        updatedAt: '2026-05-17T04:00:00.000Z',
      },
      dynamicLastRunAt: new Date('2026-05-17T04:00:00.000Z'),
    });

    await expect(
      service.renderDynamicContent('content-1', {
        force: true,
        now: new Date('2026-05-17T04:10:00.000Z'),
      })
    ).resolves.toMatchObject({
      contentId: 'content-1',
      groupEtag: 'group-etag',
    });
  });

  it('returns the current DB audio etag when audio sync fails after changing audio state', async () => {
    const service = createService({
      fetchData: () => Promise.resolve({ tempC: 21 }),
      audioEtag: 'old-audio',
      currentAudioEtag: null,
      syncAudio: async () => {
        throw new Error('audio cleanup failed');
      },
    });

    await expect(service.renderDynamicContent('content-1', { force: true })).resolves.toMatchObject(
      {
        audioEtag: null,
      }
    );
  });
});

describe('DynamicContentRendererService variants', () => {
  it('fetches once and renders the same normalized data for every enabled target', async () => {
    const providerData = { tempC: 21 };
    const renderCalls: Array<{
      target: RenderTarget;
      data: Record<string, unknown> | null;
      renderedAt: Date;
    }> = [];
    const note4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0x11);
    const virtualBytes = Buffer.alloc(VIRTUAL_RENDER_TARGET.byteLength, 0x22);
    const service = createService({
      fetchData: async () => providerData,
      renderFrame: async (ctx, target) => {
        renderCalls.push({ target, data: ctx.data, renderedAt: ctx.renderedAt });
        return target.profileId === NOTE4_RENDER_TARGET.profileId ? note4Bytes : virtualBytes;
      },
      variantResults: async (input) => {
        const note4 = await input.render(NOTE4_RENDER_TARGET);
        const virtual = await input.render(VIRTUAL_RENDER_TARGET);
        return readyVariantResults(note4, virtual);
      },
      storageBytes: {
        'note4-key': note4Bytes,
      },
    });

    await expect(service.renderDynamicContent('content-1', { force: true })).resolves.toMatchObject(
      {
        contentId: 'content-1',
        imageEtag: computeETag(note4Bytes),
        groupEtag: 'group-etag',
        unchanged: false,
      }
    );

    expect(renderCalls.map((call) => call.target.profileId)).toEqual([
      NOTE4_RENDER_TARGET.profileId,
      VIRTUAL_RENDER_TARGET.profileId,
    ]);
    expect(renderCalls[0]?.data).toBe(providerData);
    expect(renderCalls[1]?.data).toBe(providerData);
    expect(renderCalls[0]?.renderedAt).toBe(renderCalls[1]?.renderedAt);
    expect(service.harness.fetchCalls).toBe(1);
    expect(service.harness.legacyWrites).toEqual([
      {
        groupId: 'group-1',
        contentId: 'content-1',
        kind: 'image',
        bytes: note4Bytes,
      },
    ]);
    expect(service.harness.contentUpdates.at(-1)?.data).toMatchObject({
      imageEtag: computeETag(note4Bytes),
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      dynamicData: providerData,
      dynamicRefreshAttempts: 0,
      dynamicLastError: null,
    });
  });

  it('keeps a ready Note4 refresh when the virtual render fails', async () => {
    const note4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0x33);
    const service = createService({
      fetchData: async () => ({ tempC: 22 }),
      renderFrame: async (_ctx, target) => {
        if (target.profileId === VIRTUAL_RENDER_TARGET.profileId) {
          throw new Error('virtual renderer failed');
        }
        return note4Bytes;
      },
      variantResults: async (input) => {
        const note4 = await input.render(NOTE4_RENDER_TARGET);
        await expect(input.render(VIRTUAL_RENDER_TARGET)).rejects.toThrow(
          'virtual renderer failed'
        );
        return {
          contentId: 'content-1',
          renderVersion: 1,
          results: [
            readyVariant(NOTE4_RENDER_TARGET.profileId, note4, 'note4-key'),
            {
              profileId: VIRTUAL_RENDER_TARGET.profileId,
              status: 'failed',
              changed: true,
              error: 'virtual renderer failed',
            },
          ],
        };
      },
      storageBytes: {
        'note4-key': note4Bytes,
      },
    });

    await expect(service.renderDynamicContent('content-1', { force: true })).resolves.toMatchObject(
      {
        imageEtag: computeETag(note4Bytes),
        unchanged: false,
      }
    );
    expect(service.harness.legacyWrites.at(-1)?.bytes).toBe(note4Bytes);
  });

  it('rejects when Note4 rendering fails without an existing ready Note4 variant', async () => {
    const service = createService({
      fetchData: async () => ({ tempC: 24 }),
      variantResults: async () => ({
        contentId: 'content-1',
        renderVersion: 1,
        results: [
          {
            profileId: NOTE4_RENDER_TARGET.profileId,
            status: 'failed',
            changed: true,
            error: 'note4 renderer failed',
          },
          {
            profileId: VIRTUAL_RENDER_TARGET.profileId,
            status: 'ready',
            changed: true,
            frameEtag: 'virtual-etag',
            frameSize: VIRTUAL_RENDER_TARGET.byteLength,
            storageKey: 'virtual-key',
            renderVersion: 1,
          },
        ],
      }),
    });

    await expect(service.renderDynamicContent('content-1', { force: true })).rejects.toThrow(
      'Note4 动态变体渲染失败'
    );
    expect(service.harness.legacyWrites).toEqual([]);
    expect(service.harness.contentUpdates.at(-1)?.data).toMatchObject({
      dynamicLastError: 'note4 renderer failed',
      dynamicRefreshAttempts: 1,
      dynamicRefreshLeaseUntil: null,
    });
  });

  it('renders direct preview with the requested virtual display profile', async () => {
    const service = createService({
      fetchData: async () => ({ tempC: 21 }),
      renderFrame: async (_ctx, target) => Buffer.alloc(target.byteLength, 0x55),
    });

    const preview = await service.renderPreviewDirect(
      'weather',
      {},
      null,
      { tempC: 21 },
      VIRTUAL_RENDER_TARGET.profileId
    );

    expect(preview).toHaveLength(VIRTUAL_RENDER_TARGET.byteLength);
    expect(service.harness.renderTargets.at(-1)?.profileId).toBe(VIRTUAL_RENDER_TARGET.profileId);
  });

  it('renders stored-content preview with the requested virtual display profile', async () => {
    const service = createService({
      fetchData: async () => ({ tempC: 21 }),
      renderFrame: async (_ctx, target) => Buffer.alloc(target.byteLength, 0x56),
    });

    const preview = await service.renderPreview(
      'content-1',
      'user-1',
      {},
      undefined,
      VIRTUAL_RENDER_TARGET.profileId
    );

    expect(preview).toHaveLength(VIRTUAL_RENDER_TARGET.byteLength);
    expect(service.harness.renderTargets.at(-1)?.profileId).toBe(VIRTUAL_RENDER_TARGET.profileId);
  });

  it('keeps stored-content preview ownership checks before rendering a requested profile', async () => {
    const service = createService({
      fetchData: async () => ({ tempC: 21 }),
    });

    await expect(
      service.renderPreview(
        'content-1',
        'other-user',
        {},
        undefined,
        VIRTUAL_RENDER_TARGET.profileId
      )
    ).rejects.toThrow('内容不存在');
    expect(service.harness.renderTargets).toEqual([]);
  });

  it('rejects unsupported preview display profiles', async () => {
    const service = createService({
      fetchData: async () => ({ tempC: 21 }),
    });

    await expect(
      service.renderPreviewDirect('weather', {}, null, { tempC: 21 }, 'missing-profile')
    ).rejects.toThrow();
  });
});

describe('DynamicContentRendererService variant integration', () => {
  it('keeps delete queued until a dynamic render finishes and then removes all blobs', async () => {
    const renderStarted = deferred<void>();
    const renderMayFinish = deferred<void>();
    const audioEtag = 'audio-etag';
    const newNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xd1);
    const newVirtualBytes = Buffer.alloc(VIRTUAL_RENDER_TARGET.byteLength, 0xd2);
    const harness = createIntegrationHarness({
      audioEtag,
      imageEtag: 'old-image-etag',
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      renderFrame: async (_ctx, target) => {
        renderStarted.resolve();
        await renderMayFinish.promise;
        return target.profileId === NOTE4_RENDER_TARGET.profileId ? newNote4Bytes : newVirtualBytes;
      },
    });
    const sourceKey = harness.blob.sourceKey('group-1', 'content-1');
    const note4Key = harness.blob.frameKey('group-1', 'content-1', NOTE4_RENDER_TARGET.profileId);
    const virtualKey = harness.blob.frameKey(
      'group-1',
      'content-1',
      VIRTUAL_RENDER_TARGET.profileId
    );
    await harness.blob.writeStorageKey(sourceKey, 'source', Buffer.from('source bytes'));
    await harness.blob.write('group-1', 'content-1', 'image', Buffer.alloc(15_000, 0xc1));
    await harness.blob.write(
      'group-1',
      audioBlobContentId('content-1', audioEtag),
      'audio',
      Buffer.from('audio bytes')
    );
    harness.source = {
      contentId: 'content-1',
      storageKey: sourceKey,
    };

    const render = harness.service.renderDynamicContent('content-1', { force: true });
    await renderStarted.promise;
    const deletion = harness.contents.delete('content-1', 'user-1');
    let deletionSettled = false;
    deletion.finally(() => {
      deletionSettled = true;
    });

    await tick();
    expect(deletionSettled).toBe(false);

    renderMayFinish.resolve();
    await render;
    await deletion;

    expect(harness.contentExists).toBe(false);
    expect(harness.source).toBeNull();
    expect(harness.variants.rowsFor('content-1')).toEqual([]);
    expect(await harness.blob.readStorageKey(sourceKey)).toBeNull();
    expect(await harness.blob.readStorageKey(note4Key)).toBeNull();
    expect(await harness.blob.readStorageKey(virtualKey)).toBeNull();
    expect(await harness.blob.read('group-1', 'content-1', 'image')).toBeNull();
    expect(
      await harness.blob.read('group-1', audioBlobContentId('content-1', audioEtag), 'audio')
    ).toBeNull();
  });

  it('treats a preserved prior-ready Note4 fallback as a failed refresh with dynamic backoff', async () => {
    const now = new Date('2026-05-17T04:10:00.000Z');
    const harness = createIntegrationHarness({
      dynamicRefreshAttempts: 1,
      imageEtag: 'old-note4-etag',
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      renderFrame: async (_ctx, target) => {
        if (target.profileId === NOTE4_RENDER_TARGET.profileId) {
          throw new Error('note4 renderer failed');
        }
        return Buffer.alloc(target.byteLength, 0x88);
      },
    });
    const oldNote4Key = harness.blob.frameKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId
    );
    const oldVirtualKey = harness.blob.frameKey(
      'group-1',
      'content-1',
      VIRTUAL_RENDER_TARGET.profileId
    );
    const oldLegacyBytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0x44);
    const oldVirtualBytes = Buffer.alloc(VIRTUAL_RENDER_TARGET.byteLength, 0x55);
    await harness.blob.write('group-1', 'content-1', 'image', oldLegacyBytes);
    await harness.blob.writeStorageKey(oldNote4Key, 'frame', oldLegacyBytes);
    await harness.blob.writeStorageKey(oldVirtualKey, 'frame', oldVirtualBytes);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        frameEtag: 'old-note4-etag',
        storageKey: oldNote4Key,
        renderVersion: 7,
        attempts: 2,
      })
    );
    harness.variants.seed(
      readyStoredVariant(VIRTUAL_RENDER_TARGET, {
        frameEtag: 'old-virtual-etag',
        storageKey: oldVirtualKey,
        renderVersion: 7,
      })
    );

    await expect(
      harness.service.renderDynamicContent('content-1', { force: true, now })
    ).rejects.toThrow('Note4 动态变体渲染失败');

    expect(await harness.blob.read('group-1', 'content-1', 'image')).toEqual(oldLegacyBytes);
    expect(await harness.blob.readStorageKey(oldNote4Key)).toEqual(oldLegacyBytes);
    expect(await harness.blob.readStorageKey(oldVirtualKey)).toEqual(oldVirtualBytes);
    expect(harness.variants.row('content-1', NOTE4_RENDER_TARGET.profileId)).toMatchObject({
      frameEtag: 'old-note4-etag',
      storageKey: oldNote4Key,
      renderVersion: 7,
      attempts: 2,
      lastError: null,
    });
    expect(harness.variants.row('content-1', VIRTUAL_RENDER_TARGET.profileId)).toMatchObject({
      frameEtag: 'old-virtual-etag',
      storageKey: oldVirtualKey,
      renderVersion: 7,
    });
    expect(harness.content).toMatchObject({
      imageEtag: 'old-note4-etag',
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      dynamicRefreshAttempts: 2,
      dynamicLastError: 'note4 renderer failed',
    });
    expect(harness.content.dynamicNextRunAt?.getTime()).toBeGreaterThan(now.getTime());
    expect(harness.content.dynamicRefreshDueAt).toEqual(harness.content.dynamicNextRunAt);
  });

  it('leaves scheduler-owned leased Note4 fallback failures for scheduler retry marking', async () => {
    const now = new Date('2026-05-17T04:10:00.000Z');
    const leaseUntil = new Date('2026-05-17T04:13:00.000Z');
    const oldNext = new Date('2026-05-17T04:00:00.000Z');
    const harness = createIntegrationHarness({
      dynamicRefreshAttempts: 2,
      dynamicRefreshLeaseUntil: leaseUntil,
      dynamicLastError: 'previous error',
      dynamicNextRunAt: oldNext,
      dynamicRefreshDueAt: oldNext,
      imageEtag: 'old-note4-etag',
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      renderFrame: async (_ctx, target) => {
        if (target.profileId === NOTE4_RENDER_TARGET.profileId) {
          throw new Error('note4 renderer failed');
        }
        return Buffer.alloc(target.byteLength, 0x88);
      },
    });
    const oldNote4Key = harness.blob.frameKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId
    );
    const oldLegacyBytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0x44);
    await harness.blob.write('group-1', 'content-1', 'image', oldLegacyBytes);
    await harness.blob.writeStorageKey(oldNote4Key, 'frame', oldLegacyBytes);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        frameEtag: 'old-note4-etag',
        storageKey: oldNote4Key,
        renderVersion: 7,
        attempts: 2,
      })
    );

    await expect(harness.service.renderDynamicContent('content-1', { now })).rejects.toThrow(
      'Note4 动态变体渲染失败'
    );

    expect(await harness.blob.read('group-1', 'content-1', 'image')).toEqual(oldLegacyBytes);
    expect(harness.content).toMatchObject({
      dynamicRefreshAttempts: 2,
      dynamicLastError: 'previous error',
      dynamicRefreshLeaseUntil: leaseUntil,
      dynamicNextRunAt: oldNext,
      dynamicRefreshDueAt: oldNext,
    });
  });

  it('marks exactly one direct failure after rolling back a reused-fetch finalization error', async () => {
    const now = new Date('2026-05-17T04:10:00.000Z');
    const oldNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0x81);
    const oldNote4Etag = computeETag(oldNote4Bytes);
    const harness = createIntegrationHarness({
      fetchData: async () => {
        throw new Error('provider down');
      },
      dynamicData: {
        tempC: 21,
        summary: '晴',
        updatedAt: '2026-05-17T04:00:00.000Z',
      },
      dynamicLastRunAt: new Date('2026-05-17T04:00:00.000Z'),
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      failNextContentUpdate: 'content db down',
      renderFrame: async (_ctx, target) => Buffer.alloc(target.byteLength, 0x82),
    });
    const oldNote4Key = harness.blob.frameKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId
    );
    await harness.blob.write('group-1', 'content-1', 'image', oldNote4Bytes);
    await harness.blob.writeStorageKey(oldNote4Key, 'frame', oldNote4Bytes);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        frameEtag: oldNote4Etag,
        storageKey: oldNote4Key,
      })
    );

    await expect(
      harness.service.renderDynamicContent('content-1', { force: true, now })
    ).rejects.toThrow('content db down');

    const failureMarks = harness.contentUpdates.filter(
      (update) =>
        update.data.dynamicLastError === 'content db down' &&
        update.data.dynamicRefreshAttempts === 1
    );
    expect(failureMarks).toHaveLength(1);
    expect(harness.content).toMatchObject({
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      dynamicRefreshAttempts: 1,
      dynamicLastError: 'content db down',
    });
    expect(harness.content.dynamicRefreshDueAt).toEqual(harness.content.dynamicNextRunAt);
    expect(harness.content.dynamicRefreshDueAt?.getTime()).toBeGreaterThan(now.getTime());
  });

  it('restores content variants and legacy image when an unchanged final content update fails', async () => {
    const oldNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0x66);
    const oldVirtualBytes = Buffer.alloc(VIRTUAL_RENDER_TARGET.byteLength, 0x77);
    const oldNote4Etag = computeETag(oldNote4Bytes);
    const oldVirtualEtag = computeETag(oldVirtualBytes);
    const harness = createIntegrationHarness({
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      failNextContentUpdate: 'content db down',
      renderFrame: async (_ctx, target) => {
        if (target.profileId === NOTE4_RENDER_TARGET.profileId) return oldNote4Bytes;
        return Buffer.alloc(target.byteLength, 0x99);
      },
    });
    const oldNote4Key = harness.blob.frameKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId
    );
    const oldVirtualKey = harness.blob.frameKey(
      'group-1',
      'content-1',
      VIRTUAL_RENDER_TARGET.profileId
    );
    await harness.blob.write('group-1', 'content-1', 'image', oldNote4Bytes);
    await harness.blob.writeStorageKey(oldNote4Key, 'frame', oldNote4Bytes);
    await harness.blob.writeStorageKey(oldVirtualKey, 'frame', oldVirtualBytes);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        frameEtag: oldNote4Etag,
        storageKey: oldNote4Key,
        renderVersion: 3,
      })
    );
    harness.variants.seed(
      readyStoredVariant(VIRTUAL_RENDER_TARGET, {
        frameEtag: oldVirtualEtag,
        storageKey: oldVirtualKey,
        renderVersion: 3,
      })
    );

    await expect(harness.service.renderDynamicContent('content-1')).rejects.toThrow(
      'content db down'
    );

    expect(await harness.blob.read('group-1', 'content-1', 'image')).toEqual(oldNote4Bytes);
    expect(await harness.blob.readStorageKey(oldNote4Key)).toEqual(oldNote4Bytes);
    expect(await harness.blob.readStorageKey(oldVirtualKey)).toEqual(oldVirtualBytes);
    expect(harness.variants.row('content-1', NOTE4_RENDER_TARGET.profileId)).toMatchObject({
      frameEtag: oldNote4Etag,
      storageKey: oldNote4Key,
      renderVersion: 3,
    });
    expect(harness.variants.row('content-1', VIRTUAL_RENDER_TARGET.profileId)).toMatchObject({
      frameEtag: oldVirtualEtag,
      storageKey: oldVirtualKey,
      renderVersion: 3,
    });
    expect(harness.content).toMatchObject({
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      dynamicRefreshAttempts: 1,
      dynamicLastError: 'content db down',
    });
    expect(harness.content.dynamicRefreshDueAt).toEqual(harness.content.dynamicNextRunAt);
    expect(harness.transactionCount).toBe(1);
    expect(harness.variants.outsideDeleteManyCount).toBe(0);
    expect(harness.variants.outsideCreateManyCount).toBe(0);
  });

  it('restores content variants and legacy image when a changed final content update fails', async () => {
    const oldNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0x12);
    const oldVirtualBytes = Buffer.alloc(VIRTUAL_RENDER_TARGET.byteLength, 0x13);
    const oldNote4Etag = computeETag(oldNote4Bytes);
    const oldVirtualEtag = computeETag(oldVirtualBytes);
    const harness = createIntegrationHarness({
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      failNextContentUpdate: 'content db down',
      renderFrame: async (_ctx, target) => Buffer.alloc(target.byteLength, 0xab),
    });
    const oldNote4Key = harness.blob.frameKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId
    );
    const oldVirtualKey = harness.blob.frameKey(
      'group-1',
      'content-1',
      VIRTUAL_RENDER_TARGET.profileId
    );
    await harness.blob.write('group-1', 'content-1', 'image', oldNote4Bytes);
    await harness.blob.writeStorageKey(oldNote4Key, 'frame', oldNote4Bytes);
    await harness.blob.writeStorageKey(oldVirtualKey, 'frame', oldVirtualBytes);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        frameEtag: oldNote4Etag,
        storageKey: oldNote4Key,
        renderVersion: 4,
      })
    );
    harness.variants.seed(
      readyStoredVariant(VIRTUAL_RENDER_TARGET, {
        frameEtag: oldVirtualEtag,
        storageKey: oldVirtualKey,
        renderVersion: 4,
      })
    );

    await expect(
      harness.service.renderDynamicContent('content-1', { force: true })
    ).rejects.toThrow('content db down');

    expect(await harness.blob.read('group-1', 'content-1', 'image')).toEqual(oldNote4Bytes);
    expect(await harness.blob.readStorageKey(oldNote4Key)).toEqual(oldNote4Bytes);
    expect(await harness.blob.readStorageKey(oldVirtualKey)).toEqual(oldVirtualBytes);
    expect(harness.variants.row('content-1', NOTE4_RENDER_TARGET.profileId)).toMatchObject({
      frameEtag: oldNote4Etag,
      storageKey: oldNote4Key,
      renderVersion: 4,
    });
    expect(harness.variants.row('content-1', VIRTUAL_RENDER_TARGET.profileId)).toMatchObject({
      frameEtag: oldVirtualEtag,
      storageKey: oldVirtualKey,
      renderVersion: 4,
    });
    expect(harness.content).toMatchObject({
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      dynamicRefreshAttempts: 1,
      dynamicLastError: 'content db down',
    });
    expect(harness.content.dynamicRefreshDueAt).toEqual(harness.content.dynamicNextRunAt);
  });

  it('restores the old changed-render state when forward snapshot variant listing fails', async () => {
    const now = new Date('2026-05-17T04:10:00.000Z');
    const oldNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xa1);
    const oldVirtualBytes = Buffer.alloc(VIRTUAL_RENDER_TARGET.byteLength, 0xa2);
    const oldNote4Etag = computeETag(oldNote4Bytes);
    const oldVirtualEtag = computeETag(oldVirtualBytes);
    const harness = createIntegrationHarness({
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      renderFrame: async (_ctx, target) => Buffer.alloc(target.byteLength, 0xa3),
    });
    const oldNote4Key = harness.blob.frameKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId
    );
    const oldVirtualKey = harness.blob.frameKey(
      'group-1',
      'content-1',
      VIRTUAL_RENDER_TARGET.profileId
    );
    await harness.blob.write('group-1', 'content-1', 'image', oldNote4Bytes);
    await harness.blob.writeStorageKey(oldNote4Key, 'frame', oldNote4Bytes);
    await harness.blob.writeStorageKey(oldVirtualKey, 'frame', oldVirtualBytes);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        frameEtag: oldNote4Etag,
        storageKey: oldNote4Key,
      })
    );
    harness.variants.seed(
      readyStoredVariant(VIRTUAL_RENDER_TARGET, {
        frameEtag: oldVirtualEtag,
        storageKey: oldVirtualKey,
      })
    );
    harness.variants.failFindManyOnCall(3, 'forward snapshot variant list down');

    await expect(
      harness.service.renderDynamicContent('content-1', { force: true, now })
    ).rejects.toThrow('forward snapshot variant list down');

    expect(await harness.blob.read('group-1', 'content-1', 'image')).toEqual(oldNote4Bytes);
    expect(await harness.blob.readStorageKey(oldNote4Key)).toEqual(oldNote4Bytes);
    expect(await harness.blob.readStorageKey(oldVirtualKey)).toEqual(oldVirtualBytes);
    expect(harness.variants.row('content-1', NOTE4_RENDER_TARGET.profileId)).toMatchObject({
      frameEtag: oldNote4Etag,
      storageKey: oldNote4Key,
    });
    expect(harness.variants.row('content-1', VIRTUAL_RENDER_TARGET.profileId)).toMatchObject({
      frameEtag: oldVirtualEtag,
      storageKey: oldVirtualKey,
    });
    expect(harness.content).toMatchObject({
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      dynamicRefreshAttempts: 1,
      dynamicLastError: 'forward snapshot variant list down',
    });
    expect(harness.content.dynamicRefreshDueAt).toEqual(harness.content.dynamicNextRunAt);
    expect(harness.content.dynamicRefreshDueAt?.getTime()).toBeGreaterThan(now.getTime());
  });

  it('restores the old unchanged-render state when forward snapshot blob read fails', async () => {
    const now = new Date('2026-05-17T04:10:00.000Z');
    const oldNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xb1);
    const oldVirtualBytes = Buffer.alloc(VIRTUAL_RENDER_TARGET.byteLength, 0xb2);
    const newVirtualBytes = Buffer.alloc(VIRTUAL_RENDER_TARGET.byteLength, 0xb3);
    const oldNote4Etag = computeETag(oldNote4Bytes);
    const oldVirtualEtag = computeETag(oldVirtualBytes);
    const harness = createIntegrationHarness({
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      renderFrame: async (_ctx, target) =>
        target.profileId === NOTE4_RENDER_TARGET.profileId ? oldNote4Bytes : newVirtualBytes,
    });
    const oldNote4Key = harness.blob.frameKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId
    );
    const oldVirtualKey = harness.blob.frameKey(
      'group-1',
      'content-1',
      VIRTUAL_RENDER_TARGET.profileId
    );
    await harness.blob.write('group-1', 'content-1', 'image', oldNote4Bytes);
    await harness.blob.writeStorageKey(oldNote4Key, 'frame', oldNote4Bytes);
    await harness.blob.writeStorageKey(oldVirtualKey, 'frame', oldVirtualBytes);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        frameEtag: oldNote4Etag,
        storageKey: oldNote4Key,
      })
    );
    harness.variants.seed(
      readyStoredVariant(VIRTUAL_RENDER_TARGET, {
        frameEtag: oldVirtualEtag,
        storageKey: oldVirtualKey,
      })
    );
    harness.blob.failReadStorageKeyOnCall(6, 'forward snapshot blob read down');

    await expect(harness.service.renderDynamicContent('content-1', { now })).rejects.toThrow(
      'forward snapshot blob read down'
    );

    expect(await harness.blob.read('group-1', 'content-1', 'image')).toEqual(oldNote4Bytes);
    expect(await harness.blob.readStorageKey(oldNote4Key)).toEqual(oldNote4Bytes);
    expect(await harness.blob.readStorageKey(oldVirtualKey)).toEqual(oldVirtualBytes);
    expect(harness.variants.row('content-1', NOTE4_RENDER_TARGET.profileId)).toMatchObject({
      frameEtag: oldNote4Etag,
      storageKey: oldNote4Key,
    });
    expect(harness.variants.row('content-1', VIRTUAL_RENDER_TARGET.profileId)).toMatchObject({
      frameEtag: oldVirtualEtag,
      storageKey: oldVirtualKey,
    });
    expect(harness.content).toMatchObject({
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      dynamicRefreshAttempts: 1,
      dynamicLastError: 'forward snapshot blob read down',
    });
    expect(harness.content.dynamicRefreshDueAt).toEqual(harness.content.dynamicNextRunAt);
    expect(harness.content.dynamicRefreshDueAt?.getTime()).toBeGreaterThan(now.getTime());
  });

  it('leaves leased forward snapshot capture failures for scheduler retry marking', async () => {
    const now = new Date('2026-05-17T04:10:00.000Z');
    const leaseUntil = new Date('2026-05-17T04:13:00.000Z');
    const oldNext = new Date('2026-05-17T04:00:00.000Z');
    const oldNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xb4);
    const oldNote4Etag = computeETag(oldNote4Bytes);
    const harness = createIntegrationHarness({
      dynamicRefreshAttempts: 2,
      dynamicRefreshLeaseUntil: leaseUntil,
      dynamicLastError: 'previous error',
      dynamicNextRunAt: oldNext,
      dynamicRefreshDueAt: oldNext,
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      renderFrame: async (_ctx, target) => Buffer.alloc(target.byteLength, 0xb5),
    });
    const oldNote4Key = harness.blob.frameKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId
    );
    await harness.blob.write('group-1', 'content-1', 'image', oldNote4Bytes);
    await harness.blob.writeStorageKey(oldNote4Key, 'frame', oldNote4Bytes);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        frameEtag: oldNote4Etag,
        storageKey: oldNote4Key,
      })
    );
    harness.variants.failFindManyOnCall(3, 'forward snapshot variant list down');

    await expect(harness.service.renderDynamicContent('content-1', { now })).rejects.toThrow(
      'forward snapshot variant list down'
    );

    expect(harness.content).toMatchObject({
      dynamicRefreshAttempts: 2,
      dynamicLastError: 'previous error',
      dynamicRefreshLeaseUntil: leaseUntil,
      dynamicNextRunAt: oldNext,
      dynamicRefreshDueAt: oldNext,
    });
  });

  it('surfaces forward snapshot and rollback errors when capture compensation fails', async () => {
    const oldNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xc1);
    const oldNote4Etag = computeETag(oldNote4Bytes);
    const harness = createIntegrationHarness({
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      renderFrame: async (_ctx, target) => Buffer.alloc(target.byteLength, 0xc2),
    });
    const oldNote4Key = harness.blob.frameKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId
    );
    await harness.blob.write('group-1', 'content-1', 'image', oldNote4Bytes);
    await harness.blob.writeStorageKey(oldNote4Key, 'frame', oldNote4Bytes);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        frameEtag: oldNote4Etag,
        storageKey: oldNote4Key,
      })
    );
    harness.variants.failFindManyOnCall(3, 'forward snapshot variant list down');
    harness.variants.failNextCreateMany('variant restore down');

    await expect(
      harness.service.renderDynamicContent('content-1', { force: true })
    ).rejects.toMatchObject({
      message: '动态渲染失败，且回滚未完成',
      detail: {
        original_error: 'forward snapshot variant list down',
        rollback_error: 'variant restore down',
      },
    });
  });

  it('surfaces initiating, forward snapshot, and rollback errors together', async () => {
    const oldNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xc3);
    const oldNote4Etag = computeETag(oldNote4Bytes);
    const harness = createIntegrationHarness({
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      renderFrame: async (_ctx, target) => Buffer.alloc(target.byteLength, 0xc4),
    });
    const oldNote4Key = harness.blob.frameKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId
    );
    await harness.blob.write('group-1', 'content-1', 'image', oldNote4Bytes);
    await harness.blob.writeStorageKey(oldNote4Key, 'frame', oldNote4Bytes);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        frameEtag: oldNote4Etag,
        storageKey: oldNote4Key,
      })
    );
    harness.blob.failNextLegacyWrite('legacy mirror down');
    harness.variants.failFindManyOnCall(3, 'forward snapshot variant list down');
    harness.variants.failNextCreateMany('variant restore down');

    await expect(
      harness.service.renderDynamicContent('content-1', { force: true })
    ).rejects.toMatchObject({
      message: '动态渲染失败，且回滚未完成',
      detail: {
        original_error: 'legacy mirror down',
        forward_snapshot_error: 'forward snapshot variant list down',
        rollback_error: 'variant restore down',
      },
    });
  });

  it('restores committed variants when the legacy Note4 mirror write fails', async () => {
    const oldNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0x21);
    const oldVirtualBytes = Buffer.alloc(VIRTUAL_RENDER_TARGET.byteLength, 0x22);
    const harness = createIntegrationHarness({
      imageEtag: computeETag(oldNote4Bytes),
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      renderFrame: async (_ctx, target) => Buffer.alloc(target.byteLength, 0xcd),
    });
    const oldNote4Key = harness.blob.frameKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId
    );
    const oldVirtualKey = harness.blob.frameKey(
      'group-1',
      'content-1',
      VIRTUAL_RENDER_TARGET.profileId
    );
    await harness.blob.write('group-1', 'content-1', 'image', oldNote4Bytes);
    await harness.blob.writeStorageKey(oldNote4Key, 'frame', oldNote4Bytes);
    await harness.blob.writeStorageKey(oldVirtualKey, 'frame', oldVirtualBytes);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        frameEtag: computeETag(oldNote4Bytes),
        storageKey: oldNote4Key,
        renderVersion: 5,
      })
    );
    harness.variants.seed(
      readyStoredVariant(VIRTUAL_RENDER_TARGET, {
        frameEtag: computeETag(oldVirtualBytes),
        storageKey: oldVirtualKey,
        renderVersion: 5,
      })
    );
    harness.blob.failNextLegacyWrite('legacy mirror down');

    await expect(
      harness.service.renderDynamicContent('content-1', { force: true })
    ).rejects.toThrow('legacy mirror down');

    expect(await harness.blob.read('group-1', 'content-1', 'image')).toEqual(oldNote4Bytes);
    expect(await harness.blob.readStorageKey(oldNote4Key)).toEqual(oldNote4Bytes);
    expect(await harness.blob.readStorageKey(oldVirtualKey)).toEqual(oldVirtualBytes);
    expect(harness.variants.row('content-1', NOTE4_RENDER_TARGET.profileId)).toMatchObject({
      storageKey: oldNote4Key,
      renderVersion: 5,
    });
    expect(harness.variants.row('content-1', VIRTUAL_RENDER_TARGET.profileId)).toMatchObject({
      storageKey: oldVirtualKey,
      renderVersion: 5,
    });
  });

  it('surfaces both the original render failure and rollback failure when compensation fails', async () => {
    const oldNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0x31);
    const oldNote4Etag = computeETag(oldNote4Bytes);
    const harness = createIntegrationHarness({
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      failNextContentUpdate: 'content db down',
      renderFrame: async (_ctx, target) => Buffer.alloc(target.byteLength, 0xef),
    });
    const oldNote4Key = harness.blob.frameKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId
    );
    await harness.blob.write('group-1', 'content-1', 'image', oldNote4Bytes);
    await harness.blob.writeStorageKey(oldNote4Key, 'frame', oldNote4Bytes);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        frameEtag: oldNote4Etag,
        storageKey: oldNote4Key,
        renderVersion: 6,
      })
    );
    harness.variants.failNextCreateMany('variant restore down');

    await expect(
      harness.service.renderDynamicContent('content-1', { force: true })
    ).rejects.toMatchObject({
      message: '动态渲染失败，且回滚未完成',
      detail: {
        original_error: 'content db down',
        rollback_error: 'variant restore down',
      },
    });
  });

  it('rolls forward to a coherent rendered state when old database restore fails', async () => {
    const oldNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0x91);
    const oldNote4Etag = computeETag(oldNote4Bytes);
    const newNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0x92);
    const newNote4Etag = computeETag(newNote4Bytes);
    const harness = createIntegrationHarness({
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      failNextContentUpdate: 'content db down',
      renderFrame: async (_ctx, target) =>
        target.profileId === NOTE4_RENDER_TARGET.profileId
          ? newNote4Bytes
          : Buffer.alloc(target.byteLength, 0x93),
    });
    const note4Key = harness.blob.frameKey('group-1', 'content-1', NOTE4_RENDER_TARGET.profileId);
    await harness.blob.write('group-1', 'content-1', 'image', oldNote4Bytes);
    await harness.blob.writeStorageKey(note4Key, 'frame', oldNote4Bytes);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        frameEtag: oldNote4Etag,
        storageKey: note4Key,
      })
    );
    harness.variants.failNextCreateMany('variant restore down');

    await expect(
      harness.service.renderDynamicContent('content-1', { force: true })
    ).rejects.toMatchObject({
      message: '动态渲染失败，且回滚未完成',
      detail: {
        original_error: 'content db down',
        rollback_error: 'variant restore down',
      },
    });

    expect(await harness.blob.read('group-1', 'content-1', 'image')).toEqual(newNote4Bytes);
    expect(await harness.blob.readStorageKey(note4Key)).toEqual(newNote4Bytes);
    expect(harness.variants.row('content-1', NOTE4_RENDER_TARGET.profileId)).toMatchObject({
      frameEtag: newNote4Etag,
      storageKey: note4Key,
      status: 'ready',
    });
    expect(harness.content).toMatchObject({
      imageEtag: newNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      dynamicRefreshAttempts: 0,
      dynamicLastError: null,
    });
  });
});

function createService(opts: {
  fetchData: () => Promise<unknown>;
  renderFrame?: DynamicFrameRendererService['render'];
  variantResults?: VariantRenderService['renderContentVariants'];
  storageBytes?: Record<string, Buffer>;
  syncAudio?: () => Promise<boolean>;
  audioEtag?: string | null;
  currentAudioEtag?: string | null;
  dynamicData?: unknown;
  dynamicLastRunAt?: Date | null;
  imageSize?: number;
  imageEtag?: string;
  ownerUserId?: string;
}): DynamicContentRendererService & { harness: DynamicRendererHarness } {
  const harness: DynamicRendererHarness = {
    fetchCalls: 0,
    legacyWrites: [],
    contentUpdates: [],
    renderTargets: [],
  };
  const storageBytes = { ...(opts.storageBytes ?? {}) };
  const content = {
    id: 'content-1',
    groupId: 'group-1',
    frameName: null,
    kind: 'dynamic',
    dynamicType: 'weather',
    dynamicConfig: {},
    dynamicData: opts.dynamicData ?? null,
    dynamicLastRunAt: opts.dynamicLastRunAt ?? null,
    dynamicNextRunAt: null,
    audioEtag: opts.audioEtag ?? null,
    imageEtag: opts.imageEtag ?? 'old-image-etag',
    imageSize: opts.imageSize ?? 0,
    group: { ownerUserId: opts.ownerUserId ?? 'user-1' },
    dynamicRefreshAttempts: 0,
  };
  const prisma = {
    content: {
      findUnique: async (args?: { select?: { audioEtag?: boolean } }) => {
        if (
          args?.select?.audioEtag &&
          Object.keys(args.select as Record<string, unknown>).length === 1
        ) {
          return {
            audioEtag: 'currentAudioEtag' in opts ? opts.currentAudioEtag! : content.audioEtag,
          };
        }
        return content;
      },
      update: async (args: { data: Record<string, unknown> }) => {
        harness.contentUpdates.push(args);
        Object.assign(content, args.data);
        return content;
      },
    },
    contentVariant: {
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
      createMany: async (args: { data: unknown[] }) => ({ count: args.data.length }),
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
  };
  const blob = {
    read: async () => null,
    write: async (groupId: string, contentId: string, kind: 'image', bytes: Buffer) => {
      harness.legacyWrites.push({ groupId, contentId, kind, bytes });
    },
    delete: async () => undefined,
    readStorageKey: async (key: string) => storageBytes[key] ?? null,
  };
  const registry = {
    get: () => ({
      type: 'weather',
      definition: { default_ttl_sec: 300 },
      provider: {
        type: 'weather',
        validateConfig: () => ({}),
        fetchData: () => {
          harness.fetchCalls++;
          return opts.fetchData();
        },
      },
    }),
    defaultTtlSec: () => 300,
  };
  const frameRenderer = {
    render: async (...args: Parameters<DynamicFrameRendererService['render']>) => {
      harness.renderTargets.push(args[1]);
      if (opts.renderFrame) return opts.renderFrame(...args);
      return Buffer.alloc(args[1].byteLength, 0xff);
    },
  };
  const variantRenderer = {
    renderContentVariants:
      opts.variantResults ??
      (async (input) => {
        const note4 = await input.render(NOTE4_RENDER_TARGET);
        storageBytes['note4-key'] = note4;
        return {
          contentId: input.contentId,
          renderVersion: 1,
          results: [readyVariant(NOTE4_RENDER_TARGET.profileId, note4, 'note4-key')],
        };
      }),
  };
  const groups = {
    recomputeGroupEtags: async () => ({
      structureEtag: 'structure-etag',
      manifestEtag: 'group-etag',
      contentEtags: [{ id: 'content-1', etag: 'content-etag', previousEtag: 'old-content-etag' }],
    }),
  };
  const dynamicAudio = {
    sync: opts.syncAudio ?? (async () => false),
  };
  const service = new DynamicContentRendererService(
    prisma as unknown as PrismaService,
    blob as unknown as BlobService,
    registry as unknown as DynamicContentRegistry,
    frameRenderer as unknown as DynamicFrameRendererService,
    variantRenderer as unknown as VariantRenderService,
    groups as unknown as GroupsService,
    dynamicAudio as unknown as DynamicAudioService
  ) as DynamicContentRendererService & { harness: DynamicRendererHarness };
  service.harness = harness;
  return service;
}

interface DynamicRendererHarness {
  fetchCalls: number;
  legacyWrites: Array<{ groupId: string; contentId: string; kind: 'image'; bytes: Buffer }>;
  contentUpdates: Array<{ data: Record<string, unknown> }>;
  renderTargets: RenderTarget[];
}

function readyVariantResults(note4: Buffer, virtual: Buffer) {
  return {
    contentId: 'content-1',
    renderVersion: 1,
    results: [
      readyVariant(NOTE4_RENDER_TARGET.profileId, note4, 'note4-key'),
      readyVariant(VIRTUAL_RENDER_TARGET.profileId, virtual, 'virtual-key'),
    ],
  };
}

function readyVariant(profileId: string, frame: Buffer, storageKey: string) {
  return {
    profileId,
    status: 'ready' as const,
    changed: true,
    frameEtag: computeETag(frame),
    frameSize: frame.byteLength,
    storageKey,
    renderVersion: 1,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

function createIntegrationHarness(opts: {
  renderFrame: DynamicFrameRendererService['render'];
  fetchData?: () => Promise<unknown>;
  imageEtag?: string;
  imageSize?: number;
  dynamicData?: unknown;
  dynamicLastRunAt?: Date | null;
  dynamicNextRunAt?: Date | null;
  dynamicRefreshDueAt?: Date | null;
  dynamicRefreshLeaseUntil?: Date | null;
  dynamicRefreshAttempts?: number;
  dynamicLastError?: string | null;
  failNextContentUpdate?: string;
  audioEtag?: string | null;
}) {
  const content: IntegrationContent = {
    id: 'content-1',
    groupId: 'group-1',
    frameName: null,
    kind: 'dynamic',
    dynamicType: 'weather',
    dynamicConfig: {},
    dynamicData: opts.dynamicData ?? null,
    dynamicLastRunAt: opts.dynamicLastRunAt ?? null,
    dynamicNextRunAt: opts.dynamicNextRunAt ?? new Date('2026-05-17T04:15:00.000Z'),
    dynamicRefreshDueAt: opts.dynamicRefreshDueAt ?? new Date('2026-05-17T04:15:00.000Z'),
    dynamicRefreshLeaseUntil: opts.dynamicRefreshLeaseUntil ?? null,
    dynamicRefreshAttempts: opts.dynamicRefreshAttempts ?? 0,
    dynamicLastError: opts.dynamicLastError ?? null,
    audioEtag: opts.audioEtag ?? null,
    imageEtag: opts.imageEtag ?? 'old-image-etag',
    imageSize: opts.imageSize ?? 0,
  };
  let contentExists = true;
  let source: { contentId: string; storageKey: string } | null = null;
  const variants = new FakeDynamicVariantStore();
  let transactionCount = 0;
  const contentUpdates: Array<{ data: Partial<IntegrationContent> }> = [];
  const prisma = {
    content: {
      findUnique: async (args?: { select?: { audioEtag?: boolean } }) => {
        if (!contentExists) return null;
        if (
          args?.select?.audioEtag &&
          Object.keys(args.select as Record<string, unknown>).length === 1
        ) {
          return { audioEtag: content.audioEtag };
        }
        return cloneIntegrationContent(content);
      },
      update: async (args: { data: Partial<IntegrationContent> }) => {
        if (!contentExists) throw new Error('content missing');
        contentUpdates.push(args);
        if (opts.failNextContentUpdate) {
          const message = opts.failNextContentUpdate;
          opts.failNextContentUpdate = undefined;
          throw new Error(message);
        }
        Object.assign(content, args.data);
        return cloneIntegrationContent(content);
      },
      findMany: async () => [],
      delete: async (args: { where: { id: string } }) => {
        if (args.where.id !== content.id || !contentExists) throw new Error('content missing');
        contentExists = false;
        source = null;
        variants.deleteForContent(args.where.id);
        return cloneIntegrationContent(content);
      },
    },
    contentSource: {
      findUnique: async (args: { where: { contentId: string } }) =>
        source?.contentId === args.where.contentId ? { ...source } : null,
      deleteMany: async (args: { where: { contentId: string } }) => {
        const count = source?.contentId === args.where.contentId ? 1 : 0;
        if (count) source = null;
        return { count };
      },
    },
    contentVariant: variants.client,
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      transactionCount++;
      return fn({
        $queryRaw: async () => [{ id: 'group-1' }],
        $executeRaw: async () => 0,
        content: prisma.content,
        contentSource: prisma.contentSource,
        contentVariant: variants.transactionClient,
      });
    },
  };
  const blob = new FailableDynamicBlobService({ nodeEnv: 'test', blobDir } as AppConfig);
  const registry = {
    get: () => ({
      type: 'weather',
      definition: { default_ttl_sec: 300 },
      provider: {
        type: 'weather',
        validateConfig: () => ({}),
        fetchData: opts.fetchData ?? (async () => ({ tempC: 25 })),
      },
    }),
    defaultTtlSec: () => 300,
  };
  const frameRenderer = {
    render: opts.renderFrame,
  };
  const groups = {
    assertOwned: async () => undefined,
    recomputeManifestEtag: async () => 'group-etag',
    recomputeGroupEtags: async () => ({
      structureEtag: 'structure-etag',
      manifestEtag: 'group-etag',
      contentEtags: [{ id: 'content-1', etag: 'content-etag', previousEtag: 'old-content-etag' }],
    }),
  };
  const dynamicAudio = {
    sync: async () => false,
  };
  const variantRenderer = new VariantRenderService(prisma as unknown as PrismaService, blob, {
    nodeEnv: 'test',
    blobDir,
  } as AppConfig);
  const service = new DynamicContentRendererService(
    prisma as unknown as PrismaService,
    blob,
    registry as unknown as DynamicContentRegistry,
    frameRenderer as unknown as DynamicFrameRendererService,
    variantRenderer,
    groups as unknown as GroupsService,
    dynamicAudio as unknown as DynamicAudioService
  );
  const contents = new ContentsService(
    prisma as unknown as PrismaService,
    blob,
    groups as unknown as GroupsService,
    {} as never,
    {} as never,
    {} as never,
    {
      delete: async (groupId: string, contentId: string, audio: string | null) => {
        if (!audio) return;
        await blob.delete(groupId, audioBlobContentId(contentId, audio), 'audio');
      },
    } as never,
    {} as never
  );
  return {
    blob,
    content,
    get contentExists() {
      return contentExists;
    },
    get source() {
      return source;
    },
    set source(value: { contentId: string; storageKey: string } | null) {
      source = value;
    },
    contents,
    service,
    variants,
    get transactionCount() {
      return transactionCount;
    },
    contentUpdates,
  };
}

interface IntegrationContent {
  id: string;
  groupId: string;
  frameName: string | null;
  kind: string;
  dynamicType: string;
  dynamicConfig: unknown;
  dynamicData: unknown;
  dynamicLastRunAt: Date | null;
  dynamicNextRunAt: Date | null;
  dynamicRefreshDueAt: Date | null;
  dynamicRefreshLeaseUntil: Date | null;
  dynamicRefreshAttempts: number;
  dynamicLastError: string | null;
  audioEtag: string | null;
  imageEtag: string;
  imageSize: number;
}

interface StoredDynamicVariant {
  id: string;
  contentId: string;
  profileId: string;
  status: 'pending' | 'ready' | 'failed';
  pixelFormat: string;
  frameCodec: string;
  width: number;
  height: number;
  frameEtag: string | null;
  frameSize: number | null;
  storageKey: string | null;
  renderVersion: number;
  lastError: string | null;
  leaseUntil: Date | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

class FakeDynamicVariantStore {
  private readonly rows = new Map<string, StoredDynamicVariant>();
  private nextCreateManyError: Error | null = null;
  private findManyCalls = 0;
  private findManyFailure: { call: number; error: Error } | null = null;
  outsideDeleteManyCount = 0;
  outsideCreateManyCount = 0;

  readonly client = {
    findMany: async (args: { where: { contentId: string } }) => {
      this.findManyCalls++;
      if (this.findManyFailure?.call === this.findManyCalls) {
        const err = this.findManyFailure.error;
        this.findManyFailure = null;
        throw err;
      }
      return [...this.rows.values()]
        .filter((row) => row.contentId === args.where.contentId)
        .map((row) => cloneStoredVariant(row));
    },
    findUnique: async (args: {
      where: { contentId_profileId: { contentId: string; profileId: string } };
    }) => {
      const { contentId, profileId } = args.where.contentId_profileId;
      const row = this.rows.get(this.key(contentId, profileId));
      return row ? cloneStoredVariant(row) : null;
    },
    upsert: async (args: {
      where: { contentId_profileId: { contentId: string; profileId: string } };
      create: Omit<StoredDynamicVariant, 'id' | 'createdAt' | 'updatedAt'>;
      update: Partial<StoredDynamicVariant>;
    }) => {
      const { contentId, profileId } = args.where.contentId_profileId;
      const existing = this.rows.get(this.key(contentId, profileId));
      const now = new Date('2026-05-17T04:10:00.000Z');
      const next = existing
        ? { ...existing, ...args.update, updatedAt: now }
        : {
            id: `variant-${this.rows.size + 1}`,
            ...args.create,
            createdAt: now,
            updatedAt: now,
          };
      this.rows.set(this.key(contentId, profileId), cloneStoredVariant(next));
      return cloneStoredVariant(next);
    },
    deleteMany: async (args: { where: { contentId: string } }) => {
      this.outsideDeleteManyCount++;
      return this.deleteMany(args);
    },
    createMany: async (args: { data: StoredDynamicVariant[] }) => {
      this.outsideCreateManyCount++;
      return this.createMany(args);
    },
  };

  readonly transactionClient = {
    findMany: this.client.findMany,
    findUnique: this.client.findUnique,
    upsert: this.client.upsert,
    deleteMany: async (args: { where: { contentId: string } }) => this.deleteMany(args),
    createMany: async (args: { data: StoredDynamicVariant[] }) => this.createMany(args),
  };

  seed(row: StoredDynamicVariant): void {
    this.rows.set(this.key(row.contentId, row.profileId), cloneStoredVariant(row));
  }

  row(contentId: string, profileId: string): StoredDynamicVariant {
    const row = this.rows.get(this.key(contentId, profileId));
    if (!row) throw new Error(`missing fake variant row ${contentId}/${profileId}`);
    return cloneStoredVariant(row);
  }

  rowsFor(contentId: string): StoredDynamicVariant[] {
    return [...this.rows.values()]
      .filter((row) => row.contentId === contentId)
      .map((row) => cloneStoredVariant(row));
  }

  deleteForContent(contentId: string): void {
    for (const row of [...this.rows.values()]) {
      if (row.contentId === contentId) this.rows.delete(this.key(row.contentId, row.profileId));
    }
  }

  failNextCreateMany(message: string): void {
    this.nextCreateManyError = new Error(message);
  }

  failFindManyOnCall(call: number, message: string): void {
    this.findManyFailure = { call, error: new Error(message) };
  }

  private async deleteMany(args: { where: { contentId: string } }) {
    let count = 0;
    for (const row of [...this.rows.values()]) {
      if (row.contentId !== args.where.contentId) continue;
      this.rows.delete(this.key(row.contentId, row.profileId));
      count++;
    }
    return { count };
  }

  private async createMany(args: { data: StoredDynamicVariant[] }) {
    if (this.nextCreateManyError) {
      const err = this.nextCreateManyError;
      this.nextCreateManyError = null;
      throw err;
    }
    for (const row of args.data) {
      this.rows.set(this.key(row.contentId, row.profileId), cloneStoredVariant(row));
    }
    return { count: args.data.length };
  }

  private key(contentId: string, profileId: string): string {
    return `${contentId}/${profileId}`;
  }
}

function cloneIntegrationContent(content: IntegrationContent): IntegrationContent {
  return {
    ...content,
    dynamicLastRunAt: cloneDate(content.dynamicLastRunAt),
    dynamicNextRunAt: cloneDate(content.dynamicNextRunAt),
    dynamicRefreshDueAt: cloneDate(content.dynamicRefreshDueAt),
    dynamicRefreshLeaseUntil: cloneDate(content.dynamicRefreshLeaseUntil),
  };
}

function cloneStoredVariant(row: StoredDynamicVariant): StoredDynamicVariant {
  return {
    ...row,
    leaseUntil: cloneDate(row.leaseUntil),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function cloneDate(value: Date | null): Date | null {
  return value ? new Date(value) : null;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class FailableDynamicBlobService extends BlobService {
  private nextLegacyWriteError: Error | null = null;
  private readStorageKeyCalls = 0;
  private readStorageKeyFailure: { call: number; error: Error } | null = null;

  failNextLegacyWrite(message: string): void {
    this.nextLegacyWriteError = new Error(message);
  }

  failReadStorageKeyOnCall(call: number, message: string): void {
    this.readStorageKeyFailure = { call, error: new Error(message) };
  }

  override async write(
    groupId: string,
    contentId: string,
    kind: Parameters<BlobService['write']>[2],
    data: Parameters<BlobService['write']>[3]
  ): Promise<{ path: string; size: number }> {
    if (this.nextLegacyWriteError && groupId === 'group-1' && contentId === 'content-1') {
      const err = this.nextLegacyWriteError;
      this.nextLegacyWriteError = null;
      throw err;
    }
    return super.write(groupId, contentId, kind, data);
  }

  override async readStorageKey(
    storageKey: string
  ): Promise<Awaited<ReturnType<BlobService['readStorageKey']>>> {
    this.readStorageKeyCalls++;
    if (this.readStorageKeyFailure?.call === this.readStorageKeyCalls) {
      const err = this.readStorageKeyFailure.error;
      this.readStorageKeyFailure = null;
      throw err;
    }
    return super.readStorageKey(storageKey);
  }
}

function readyStoredVariant(
  target: RenderTarget,
  overrides: Partial<StoredDynamicVariant> = {}
): StoredDynamicVariant {
  return {
    id: `seed-${target.profileId}`,
    contentId: 'content-1',
    profileId: target.profileId,
    status: 'ready',
    pixelFormat: target.pixelFormat,
    frameCodec: target.frameCodec,
    width: target.width,
    height: target.height,
    frameEtag: `etag-${target.profileId}`,
    frameSize: target.byteLength,
    storageKey: `frames/${target.profileId}/group-1/content-1.img`,
    renderVersion: 1,
    lastError: null,
    leaseUntil: null,
    attempts: 0,
    createdAt: new Date('2026-05-17T04:00:00.000Z'),
    updatedAt: new Date('2026-05-17T04:00:00.000Z'),
    ...overrides,
  };
}
