import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, stat, utimes } from 'node:fs/promises';
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
import { ContentMutationCoordinator } from '../../common/worker/content-mutation-coordinator';
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
const CANDIDATE_GC_HORIZON_MS = 24 * 60 * 60 * 1000;

let blobDir = '/tmp/slatehub-dynamic-render-test';

beforeEach(async () => {
  blobDir = await mkdtemp(join(tmpdir(), 'slatehub-dynamic-render-test-'));
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
    expect(service.harness.contentUpdates.at(-1)?.data).toMatchObject({
      dynamicLastError: '动态数据必须是 JSON 对象或 null',
      dynamicRefreshLeaseUntil: null,
      dynamicRefreshLeaseToken: null,
    });
  });

  it('releases a foreground lease with token CAS when the first content read fails', async () => {
    const takeoverToken = '22222222-2222-4222-8222-222222222222';
    const takeoverLeaseUntil = new Date('2026-05-17T04:20:00.000Z');
    const service = createService({
      fetchData: () => Promise.resolve({ tempC: 21 }),
      failContentFindUniqueOnce: 'content read failed',
      beforeContentFindUniqueError: (content) => {
        content.dynamicRefreshLeaseToken = takeoverToken;
        content.dynamicRefreshLeaseUntil = takeoverLeaseUntil;
      },
    });

    await expect(service.renderDynamicContent('content-1', { force: true })).rejects.toThrow(
      'content read failed'
    );

    const claim = service.harness.contentUpdates.find(
      (update) => typeof update.data.dynamicRefreshLeaseToken === 'string'
    );
    const claimToken = claim?.data.dynamicRefreshLeaseToken;
    expect(claimToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(service.harness.contentUpdates).toContainEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'content-1',
          kind: 'dynamic',
          dynamicRefreshLeaseToken: claimToken,
        }),
        data: expect.objectContaining({
          dynamicRefreshLeaseUntil: null,
          dynamicRefreshLeaseToken: null,
        }),
      })
    );
    expect(service.harness.content.dynamicRefreshLeaseToken).toBe(takeoverToken);
    expect(service.harness.content.dynamicRefreshLeaseUntil).toEqual(takeoverLeaseUntil);
  });

  it('does not release scheduler-owned leases when the first content read fails', async () => {
    const schedulerToken = '11111111-1111-4111-8111-111111111111';
    const schedulerLeaseUntil = new Date('2026-05-17T04:20:00.000Z');
    const service = createService({
      fetchData: () => Promise.resolve({ tempC: 21 }),
      failContentFindUniqueOnce: 'content read failed',
      dynamicRefreshLeaseToken: schedulerToken,
      dynamicRefreshLeaseUntil: schedulerLeaseUntil,
    });

    await expect(
      service.renderDynamicContent('content-1', {
        force: true,
        schedulerLeaseToken: schedulerToken,
        schedulerLeaseUntil,
        claimedLeaseOwner: 'scheduler',
      })
    ).rejects.toThrow('content read failed');

    expect(service.harness.contentUpdates).not.toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          dynamicRefreshLeaseUntil: null,
          dynamicRefreshLeaseToken: null,
        }),
      })
    );
    expect(service.harness.content.dynamicRefreshLeaseToken).toBe(schedulerToken);
    expect(service.harness.content.dynamicRefreshLeaseUntil).toEqual(schedulerLeaseUntil);
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
    expect(service.harness.legacyWrites).toEqual([]);
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
    expect(service.harness.legacyWrites).toEqual([]);
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
      dynamicRefreshLeaseToken: null,
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
    expect(harness.deletedVariantStorageKeys).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^frames\/zectrix-note4-400x300-mono\/group-1\/content-1\.[0-9a-f-]+\.img$/i
        ),
        expect.stringMatching(
          /^frames\/virtual-mono-296x128\/group-1\/content-1\.[0-9a-f-]+\.img$/i
        ),
      ])
    );
    for (const storageKey of harness.deletedVariantStorageKeys) {
      expect(await harness.blob.readStorageKey(storageKey)).toBeNull();
    }
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
    const leaseToken = '11111111-1111-4111-8111-111111111111';
    const oldNext = new Date('2026-05-17T04:00:00.000Z');
    const harness = createIntegrationHarness({
      dynamicRefreshAttempts: 2,
      dynamicRefreshLeaseUntil: leaseUntil,
      dynamicRefreshLeaseToken: leaseToken,
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

    await expect(
      harness.service.renderDynamicContent('content-1', {
        now,
        schedulerLeaseUntil: leaseUntil,
        schedulerLeaseToken: leaseToken,
      })
    ).rejects.toThrow('Note4 动态变体渲染失败');

    expect(await harness.blob.read('group-1', 'content-1', 'image')).toEqual(oldLegacyBytes);
    expect(harness.content).toMatchObject({
      dynamicRefreshAttempts: 2,
      dynamicLastError: 'previous error',
      dynamicRefreshLeaseUntil: leaseUntil,
      dynamicRefreshLeaseToken: leaseToken,
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

  it('keeps existing variants and legacy image when an unchanged final content update fails', async () => {
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

  it('keeps existing variants and legacy image when a changed final content update fails', async () => {
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

  it('does not overwrite a newer scheduler lease when finalizing an expired leased render', async () => {
    const l1Lease = new Date('2026-05-17T04:13:00.000Z');
    const l2Lease = new Date('2026-05-17T04:16:00.000Z');
    const l1Token = '11111111-1111-4111-8111-111111111111';
    const l2Token = '22222222-2222-4222-8222-222222222222';
    const oldNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xd4);
    const oldVirtualBytes = Buffer.alloc(VIRTUAL_RENDER_TARGET.byteLength, 0xd5);
    const newNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xd6);
    const newVirtualBytes = Buffer.alloc(VIRTUAL_RENDER_TARGET.byteLength, 0xd7);
    const oldNote4Etag = computeETag(oldNote4Bytes);
    const oldVirtualEtag = computeETag(oldVirtualBytes);
    const harness = createIntegrationHarness({
      dynamicRefreshLeaseUntil: l1Lease,
      dynamicRefreshLeaseToken: l1Token,
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      renderFrame: async (_ctx, target) =>
        target.profileId === NOTE4_RENDER_TARGET.profileId ? newNote4Bytes : newVirtualBytes,
    });
    const note4Key = harness.blob.frameKey('group-1', 'content-1', NOTE4_RENDER_TARGET.profileId);
    const virtualKey = harness.blob.frameKey(
      'group-1',
      'content-1',
      VIRTUAL_RENDER_TARGET.profileId
    );
    await harness.blob.write('group-1', 'content-1', 'image', oldNote4Bytes);
    await harness.blob.writeStorageKey(note4Key, 'frame', oldNote4Bytes);
    await harness.blob.writeStorageKey(virtualKey, 'frame', oldVirtualBytes);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        frameEtag: oldNote4Etag,
        storageKey: note4Key,
        renderVersion: 4,
      })
    );
    harness.variants.seed(
      readyStoredVariant(VIRTUAL_RENDER_TARGET, {
        frameEtag: oldVirtualEtag,
        storageKey: virtualKey,
        renderVersion: 4,
      })
    );
    harness.beforeContentUpdate = () => {
      harness.content.dynamicRefreshLeaseUntil = l2Lease;
      harness.content.dynamicRefreshLeaseToken = l2Token;
    };

    await expect(
      harness.service.renderDynamicContent('content-1', {
        schedulerLeaseUntil: l1Lease,
        schedulerLeaseToken: l1Token,
        now: new Date('2026-05-17T04:10:00.000Z'),
      })
    ).rejects.toThrow('动态刷新 lease 已被其它 worker 接管');

    expect(harness.content).toMatchObject({
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      dynamicRefreshLeaseUntil: l2Lease,
      dynamicRefreshLeaseToken: l2Token,
    });
    expect(harness.variants.row('content-1', NOTE4_RENDER_TARGET.profileId)).toMatchObject({
      frameEtag: oldNote4Etag,
      storageKey: note4Key,
      renderVersion: 4,
    });
    expect(harness.variants.row('content-1', VIRTUAL_RENDER_TARGET.profileId)).toMatchObject({
      frameEtag: oldVirtualEtag,
      storageKey: virtualKey,
      renderVersion: 4,
    });
    expect(await harness.blob.read('group-1', 'content-1', 'image')).toEqual(oldNote4Bytes);
    expect(await harness.blob.readStorageKey(note4Key)).toEqual(oldNote4Bytes);
    expect(await harness.blob.readStorageKey(virtualKey)).toEqual(oldVirtualBytes);
  });

  it('fences an overlapped stale worker with the same leaseUntil but a different token', async () => {
    const leaseUntil = new Date('2026-05-17T04:13:00.000Z');
    const t1Token = '11111111-1111-4111-8111-111111111111';
    const t2Token = '22222222-2222-4222-8222-222222222222';
    const oldNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xe1);
    const oldNote4Etag = computeETag(oldNote4Bytes);
    const t2Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xe3);
    const t2Etag = computeETag(t2Bytes);
    const t1Started = deferred<void>();
    const t1MayContinue = deferred<void>();
    let phase: 't1' | 't2' = 't1';
    const harness = createIntegrationHarness({
      dynamicRefreshLeaseUntil: leaseUntil,
      dynamicRefreshLeaseToken: t1Token,
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      renderFrame: async (_ctx, target) => {
        if (phase === 't1') {
          if (target.profileId === NOTE4_RENDER_TARGET.profileId) {
            t1Started.resolve();
            await t1MayContinue.promise;
          }
          return Buffer.alloc(target.byteLength, 0xe2);
        }
        return Buffer.alloc(target.byteLength, 0xe3);
      },
    });
    const oldNote4Key = harness.blob.frameKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId
    );
    await harness.blob.writeStorageKey(oldNote4Key, 'frame', oldNote4Bytes);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        frameEtag: oldNote4Etag,
        storageKey: oldNote4Key,
        renderVersion: 4,
      })
    );

    const t1 = harness.service.renderDynamicContent('content-1', {
      schedulerLeaseUntil: leaseUntil,
      schedulerLeaseToken: t1Token,
      now: new Date('2026-05-17T04:10:00.000Z'),
    });
    await t1Started.promise;

    harness.content.dynamicRefreshLeaseUntil = leaseUntil;
    harness.content.dynamicRefreshLeaseToken = t2Token;
    phase = 't2';
    await expect(
      harness.makeService({ isolated: true }).renderDynamicContent('content-1', {
        schedulerLeaseUntil: leaseUntil,
        schedulerLeaseToken: t2Token,
        now: new Date('2026-05-17T04:10:01.000Z'),
      })
    ).resolves.toMatchObject({ imageEtag: t2Etag });

    t1MayContinue.resolve();
    await expect(t1).rejects.toThrow('动态刷新 lease 已被其它 worker 接管');

    const t2Note4Key = `frames/${NOTE4_RENDER_TARGET.profileId}/group-1/content-1.${t2Token}.img`;
    const t1Note4Key = `frames/${NOTE4_RENDER_TARGET.profileId}/group-1/content-1.${t1Token}.img`;
    expect(harness.content).toMatchObject({
      imageEtag: t2Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      dynamicRefreshLeaseUntil: null,
      dynamicRefreshLeaseToken: null,
    });
    expect(harness.variants.row('content-1', NOTE4_RENDER_TARGET.profileId)).toMatchObject({
      frameEtag: t2Etag,
      storageKey: t2Note4Key,
      renderVersion: 5,
    });
    expect(await harness.blob.readStorageKey(t2Note4Key)).toEqual(t2Bytes);
    expect(await harness.blob.readStorageKey(t1Note4Key)).toEqual(Buffer.alloc(15_000, 0xe2));
    expect(await harness.blob.readStorageKey(oldNote4Key)).toEqual(oldNote4Bytes);
  });

  it('allows only one foreground renderer to claim a cross-service lease', async () => {
    const oldNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xf1);
    const oldNote4Etag = computeETag(oldNote4Bytes);
    const newNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xf2);
    const newNote4Etag = computeETag(newNote4Bytes);
    const t1Started = deferred<void>();
    const t1MayContinue = deferred<void>();
    const harness = createIntegrationHarness({
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      renderFrame: async (_ctx, target) => {
        if (target.profileId === NOTE4_RENDER_TARGET.profileId) {
          t1Started.resolve();
          await t1MayContinue.promise;
        }
        return Buffer.alloc(target.byteLength, 0xf2);
      },
    });
    const oldNote4Key = harness.blob.frameKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId
    );
    await harness.blob.writeStorageKey(oldNote4Key, 'frame', oldNote4Bytes);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        frameEtag: oldNote4Etag,
        storageKey: oldNote4Key,
        renderVersion: 3,
      })
    );

    const t1 = harness.service.renderDynamicContent('content-1', {
      force: true,
      now: new Date('2026-05-17T04:10:00.000Z'),
    });
    await t1Started.promise;
    const t1Token = harness.content.dynamicRefreshLeaseToken;
    expect(t1Token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );

    await expect(
      harness.makeService({ isolated: true }).renderDynamicContent('content-1', {
        force: true,
        now: new Date('2026-05-17T04:10:01.000Z'),
      })
    ).rejects.toThrow('动态刷新 lease 已被其它 worker 接管');

    t1MayContinue.resolve();
    await expect(t1).resolves.toMatchObject({ imageEtag: newNote4Etag });

    const t1Note4Key = `frames/${NOTE4_RENDER_TARGET.profileId}/group-1/content-1.${t1Token}.img`;
    expect(harness.content).toMatchObject({
      imageEtag: newNote4Etag,
      dynamicRefreshLeaseUntil: null,
      dynamicRefreshLeaseToken: null,
    });
    expect(harness.variants.row('content-1', NOTE4_RENDER_TARGET.profileId)).toMatchObject({
      frameEtag: newNote4Etag,
      storageKey: t1Note4Key,
      renderVersion: 4,
    });
    expect(await harness.blob.readStorageKey(t1Note4Key)).toEqual(newNote4Bytes);
  });

  it('keeps superseded UUID frame keys after publish until delayed GC removes them', async () => {
    const oldNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xf3);
    const oldNote4Etag = computeETag(oldNote4Bytes);
    const newNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xf4);
    const newNote4Etag = computeETag(newNote4Bytes);
    const harness = createIntegrationHarness({
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      renderFrame: async (_ctx, target) =>
        target.profileId === NOTE4_RENDER_TARGET.profileId
          ? newNote4Bytes
          : Buffer.alloc(target.byteLength, 0xf5),
    });
    const oldToken = '44444444-4444-4444-8444-444444444444';
    const oldNote4Key = harness.blob.frameCandidateKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId,
      oldToken
    );
    await harness.blob.writeStorageKey(oldNote4Key, 'frame', oldNote4Bytes);
    const oldDate = new Date('2026-05-15T04:10:00.000Z');
    await utimes(harness.blob.storagePath(oldNote4Key), oldDate, oldDate);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        frameEtag: oldNote4Etag,
        storageKey: oldNote4Key,
        renderVersion: 6,
      })
    );

    await expect(
      harness.service.renderDynamicContent('content-1', {
        force: true,
        now: new Date('2026-05-17T04:10:00.000Z'),
      })
    ).resolves.toMatchObject({ imageEtag: newNote4Etag });

    const committed = harness.variants.row('content-1', NOTE4_RENDER_TARGET.profileId);
    expect(committed).toMatchObject({
      frameEtag: newNote4Etag,
      renderVersion: 7,
    });
    expect(committed.storageKey).toMatch(
      /^frames\/zectrix-note4-400x300-mono\/group-1\/content-1\.[0-9a-f-]+\.img$/i
    );
    expect(await harness.blob.readStorageKey(committed.storageKey!)).toEqual(newNote4Bytes);
    expect(await harness.blob.readStorageKey(oldNote4Key)).toEqual(oldNote4Bytes);
    const touchedMtimeMs = (await stat(harness.blob.storagePath(oldNote4Key))).mtimeMs;

    await expect(
      harness.service.cleanupStaleDynamicRenderCandidates(
        new Date(touchedMtimeMs + CANDIDATE_GC_HORIZON_MS - 1)
      )
    ).resolves.toBe(0);
    expect(await harness.blob.readStorageKey(oldNote4Key)).toEqual(oldNote4Bytes);

    await expect(
      harness.service.cleanupStaleDynamicRenderCandidates(
        new Date(touchedMtimeMs + CANDIDATE_GC_HORIZON_MS + 1)
      )
    ).resolves.toBe(1);
    expect(await harness.blob.readStorageKey(oldNote4Key)).toBeNull();
  });

  it('touches superseded canonical frame keys before publish so delayed GC keeps them for a grace window', async () => {
    const oldNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xe3);
    const oldNote4Etag = computeETag(oldNote4Bytes);
    const newNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xe4);
    const newNote4Etag = computeETag(newNote4Bytes);
    const harness = createIntegrationHarness({
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      renderFrame: async (_ctx, target) =>
        target.profileId === NOTE4_RENDER_TARGET.profileId
          ? newNote4Bytes
          : Buffer.alloc(target.byteLength, 0xe5),
    });
    const oldNote4Key = harness.blob.frameKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId
    );
    await harness.blob.writeStorageKey(oldNote4Key, 'frame', oldNote4Bytes);
    const oldDate = new Date('2026-05-15T04:10:00.000Z');
    await utimes(harness.blob.storagePath(oldNote4Key), oldDate, oldDate);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        frameEtag: oldNote4Etag,
        storageKey: oldNote4Key,
        renderVersion: 6,
      })
    );

    await expect(
      harness.service.renderDynamicContent('content-1', {
        force: true,
        now: new Date('2026-05-17T04:10:00.000Z'),
      })
    ).resolves.toMatchObject({ imageEtag: newNote4Etag });

    const committed = harness.variants.row('content-1', NOTE4_RENDER_TARGET.profileId);
    expect(committed).toMatchObject({
      frameEtag: newNote4Etag,
      renderVersion: 7,
    });
    expect(committed.storageKey).not.toBe(oldNote4Key);
    expect(await harness.blob.readStorageKey(oldNote4Key)).toEqual(oldNote4Bytes);
    const touchedMtimeMs = (await stat(harness.blob.storagePath(oldNote4Key))).mtimeMs;

    await expect(
      harness.service.cleanupStaleDynamicRenderCandidates(
        new Date(touchedMtimeMs + CANDIDATE_GC_HORIZON_MS - 1)
      )
    ).resolves.toBe(0);
    expect(await harness.blob.readStorageKey(oldNote4Key)).toEqual(oldNote4Bytes);

    await expect(
      harness.service.cleanupStaleDynamicRenderCandidates(
        new Date(touchedMtimeMs + CANDIDATE_GC_HORIZON_MS + 1)
      )
    ).resolves.toBe(1);
    expect(await harness.blob.readStorageKey(oldNote4Key)).toBeNull();
  });

  it('does not commit a variant switch when touching the superseded frame key fails', async () => {
    const oldNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xd3);
    const oldNote4Etag = computeETag(oldNote4Bytes);
    const newNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xd4);
    const harness = createIntegrationHarness({
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      renderFrame: async (_ctx, target) =>
        target.profileId === NOTE4_RENDER_TARGET.profileId
          ? newNote4Bytes
          : Buffer.alloc(target.byteLength, 0xd5),
    });
    const oldNote4Key = harness.blob.frameCandidateKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId,
      '55555555-5555-4555-8555-555555555555'
    );
    await harness.blob.writeStorageKey(oldNote4Key, 'frame', oldNote4Bytes);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        frameEtag: oldNote4Etag,
        storageKey: oldNote4Key,
        renderVersion: 6,
      })
    );
    harness.blob.touchStorageKey = async () => {
      throw new Error('touch failed');
    };

    await expect(
      harness.service.renderDynamicContent('content-1', {
        force: true,
        now: new Date('2026-05-17T04:10:00.000Z'),
      })
    ).rejects.toThrow('touch failed');

    expect(harness.variants.row('content-1', NOTE4_RENDER_TARGET.profileId)).toMatchObject({
      frameEtag: oldNote4Etag,
      storageKey: oldNote4Key,
      renderVersion: 6,
    });
  });

  it('locks the group row before content CAS and variant commits when finalizing', async () => {
    const harness = createIntegrationHarness({
      renderFrame: async (_ctx, target) => Buffer.alloc(target.byteLength, 0xa4),
    });

    await expect(
      harness.service.renderDynamicContent('content-1', {
        force: true,
        now: new Date('2026-05-17T04:10:00.000Z'),
      })
    ).resolves.toMatchObject({ contentId: 'content-1' });

    expect(harness.lastTransactionOps[0]).toBe('$queryRaw');
    expect(harness.lastTransactionOps.indexOf('$queryRaw')).toBeLessThan(
      harness.lastTransactionOps.indexOf('content.updateMany')
    );
    expect(harness.lastTransactionOps.indexOf('content.updateMany')).toBeLessThan(
      harness.lastTransactionOps.indexOf('contentVariant.findMany')
    );
  });

  it('preserves unreferenced candidates when finalization transaction rejects', async () => {
    const oldNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xf3);
    const oldNote4Etag = computeETag(oldNote4Bytes);
    const newNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xf4);
    const harness = createIntegrationHarness({
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      failNextContentUpdate: 'content db down',
      renderFrame: async (_ctx, target) =>
        target.profileId === NOTE4_RENDER_TARGET.profileId
          ? newNote4Bytes
          : Buffer.alloc(target.byteLength, 0xf5),
    });
    const oldNote4Key = harness.blob.frameKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId
    );
    await harness.blob.writeStorageKey(oldNote4Key, 'frame', oldNote4Bytes);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        frameEtag: oldNote4Etag,
        storageKey: oldNote4Key,
        renderVersion: 6,
      })
    );

    await expect(
      harness.service.renderDynamicContent('content-1', {
        force: true,
        now: new Date('2026-05-17T04:10:00.000Z'),
      })
    ).rejects.toThrow('content db down');

    const claim = harness.contentUpdates.find(
      (update) => typeof update.data.dynamicRefreshLeaseToken === 'string'
    );
    const token = claim?.data.dynamicRefreshLeaseToken;
    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    const candidateKey = `frames/${NOTE4_RENDER_TARGET.profileId}/group-1/content-1.${token}.img`;
    expect(harness.variants.row('content-1', NOTE4_RENDER_TARGET.profileId)).toMatchObject({
      frameEtag: oldNote4Etag,
      storageKey: oldNote4Key,
      renderVersion: 6,
    });
    expect(await harness.blob.readStorageKey(candidateKey)).toEqual(newNote4Bytes);
    expect(await harness.blob.readStorageKey(oldNote4Key)).toEqual(oldNote4Bytes);
  });

  it('fences a renderer whose input lease is cleared by a frame-name mutation', async () => {
    const oldToken = '11111111-1111-4111-8111-111111111111';
    const oldLease = new Date('2026-05-17T04:13:00.000Z');
    const oldNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xb1);
    const oldNote4Etag = computeETag(oldNote4Bytes);
    const newNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xb3);
    const newNote4Etag = computeETag(newNote4Bytes);
    const staleStarted = deferred<void>();
    const staleMayContinue = deferred<void>();
    let phase: 'stale' | 'fresh' = 'stale';
    const harness = createIntegrationHarness({
      dynamicRefreshLeaseUntil: oldLease,
      dynamicRefreshLeaseToken: oldToken,
      imageEtag: oldNote4Etag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      renderFrame: async (_ctx, target) => {
        if (phase === 'stale' && target.profileId === NOTE4_RENDER_TARGET.profileId) {
          staleStarted.resolve();
          await staleMayContinue.promise;
          return Buffer.alloc(target.byteLength, 0xb2);
        }
        return Buffer.alloc(target.byteLength, 0xb3);
      },
    });
    const oldNote4Key = harness.blob.frameKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId
    );
    await harness.blob.writeStorageKey(oldNote4Key, 'frame', oldNote4Bytes);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        frameEtag: oldNote4Etag,
        storageKey: oldNote4Key,
        renderVersion: 2,
      })
    );

    const stale = harness.service.renderDynamicContent('content-1', {
      schedulerLeaseUntil: oldLease,
      schedulerLeaseToken: oldToken,
      now: new Date('2026-05-17T04:10:00.000Z'),
    });
    await staleStarted.promise;

    harness.content.frameName = 'mutated-frame';
    harness.content.dynamicRefreshLeaseUntil = null;
    harness.content.dynamicRefreshLeaseToken = null;
    phase = 'fresh';
    await expect(
      harness.makeService({ isolated: true }).renderDynamicContent('content-1', {
        force: true,
        now: new Date('2026-05-17T04:10:01.000Z'),
      })
    ).resolves.toMatchObject({ imageEtag: newNote4Etag });

    staleMayContinue.resolve();
    await expect(stale).rejects.toThrow('动态刷新 lease 已被其它 worker 接管');

    expect(harness.content).toMatchObject({
      frameName: 'mutated-frame',
      imageEtag: newNote4Etag,
      dynamicRefreshLeaseUntil: null,
      dynamicRefreshLeaseToken: null,
    });
    expect(harness.variants.row('content-1', NOTE4_RENDER_TARGET.profileId)).toMatchObject({
      frameEtag: newNote4Etag,
    });
    expect(await harness.blob.readStorageKey(oldNote4Key)).toEqual(oldNote4Bytes);
  });

  it('does not let a stale foreground error marker clear a newer takeover lease', async () => {
    const takeoverToken = '22222222-2222-4222-8222-222222222222';
    const takeoverLease = new Date('2026-05-17T04:20:00.000Z');
    const state: { harness?: ReturnType<typeof createIntegrationHarness> } = {};
    const harness = createIntegrationHarness({
      fetchData: async () => {
        state.harness!.beforeContentUpdate = () => {
          state.harness!.content.dynamicRefreshLeaseUntil = takeoverLease;
          state.harness!.content.dynamicRefreshLeaseToken = takeoverToken;
        };
        throw new Error('provider down');
      },
      renderFrame: async (_ctx, target) => Buffer.alloc(target.byteLength, 0xc1),
    });
    state.harness = harness;

    await expect(
      harness.service.renderDynamicContent('content-1', {
        force: true,
        now: new Date('2026-05-17T04:10:00.000Z'),
      })
    ).rejects.toThrow('provider down');

    expect(harness.content).toMatchObject({
      dynamicLastError: null,
      dynamicRefreshAttempts: 0,
      dynamicRefreshLeaseUntil: takeoverLease,
      dynamicRefreshLeaseToken: takeoverToken,
    });
  });

  it('reads render input only after a foreground lease claim succeeds', async () => {
    const claimMayContinue = deferred<void>();
    const mutatedBytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xd2);
    const mutatedEtag = computeETag(mutatedBytes);
    const harness = createIntegrationHarness({
      renderFrame: async (ctx, target) => {
        expect(ctx.frameName).toBe('mutated-frame');
        return Buffer.alloc(target.byteLength, 0xd2);
      },
    });
    harness.content.frameName = 'old-frame';
    harness.beforeContentUpdate = () => {
      harness.content.frameName = 'mutated-frame';
      harness.content.dynamicRefreshLeaseUntil = null;
      harness.content.dynamicRefreshLeaseToken = null;
      return claimMayContinue.promise;
    };

    const render = harness.service.renderDynamicContent('content-1', {
      force: true,
      now: new Date('2026-05-17T04:10:00.000Z'),
    });
    await tick();
    expect(harness.content.frameName).toBe('mutated-frame');

    claimMayContinue.resolve();
    await expect(render).resolves.toMatchObject({ imageEtag: mutatedEtag });
    expect(harness.content).toMatchObject({
      frameName: 'mutated-frame',
      imageEtag: mutatedEtag,
      dynamicRefreshLeaseUntil: null,
      dynamicRefreshLeaseToken: null,
    });
  });

  it('lets dashboard ingest takeover publish new data while an old scheduler render is paused', async () => {
    const schedulerToken = '11111111-1111-4111-8111-111111111111';
    const ingestToken = '22222222-2222-4222-8222-222222222222';
    const leaseUntil = new Date('2026-05-17T04:13:00.000Z');
    const ingestLeaseUntil = new Date('2026-05-17T04:14:00.000Z');
    const oldBytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xe1);
    const oldEtag = computeETag(oldBytes);
    const ingestBytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0xe3);
    const ingestEtag = computeETag(ingestBytes);
    const schedulerStarted = deferred<void>();
    const schedulerMayContinue = deferred<void>();
    let phase: 'scheduler' | 'ingest' = 'scheduler';
    const harness = createIntegrationHarness({
      dynamicType: 'dashboard',
      dynamicRefreshLeaseUntil: leaseUntil,
      dynamicRefreshLeaseToken: schedulerToken,
      dynamicData: { source: 'old' },
      fetchData: async () => ({ source: 'old' }),
      imageEtag: oldEtag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      renderFrame: async (ctx, target) => {
        if (phase === 'scheduler' && target.profileId === NOTE4_RENDER_TARGET.profileId) {
          expect(ctx.data).toMatchObject({ source: 'old' });
          schedulerStarted.resolve();
          await schedulerMayContinue.promise;
          return Buffer.alloc(target.byteLength, 0xe2);
        }
        expect(ctx.data).toMatchObject({ source: 'ingest' });
        return Buffer.alloc(target.byteLength, 0xe3);
      },
    });
    const oldKey = harness.blob.frameKey('group-1', 'content-1', NOTE4_RENDER_TARGET.profileId);
    await harness.blob.writeStorageKey(oldKey, 'frame', oldBytes);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        frameEtag: oldEtag,
        storageKey: oldKey,
        renderVersion: 2,
      })
    );

    const scheduler = harness.service.renderDynamicContent('content-1', {
      schedulerLeaseUntil: leaseUntil,
      schedulerLeaseToken: schedulerToken,
      now: new Date('2026-05-17T04:10:00.000Z'),
    });
    await schedulerStarted.promise;

    harness.content.dynamicRefreshLeaseUntil = ingestLeaseUntil;
    harness.content.dynamicRefreshLeaseToken = ingestToken;
    phase = 'ingest';
    await expect(
      harness.makeService({ isolated: true }).renderDynamicContent('content-1', {
        force: true,
        dataOverride: { source: 'ingest' },
        schedulerLeaseUntil: ingestLeaseUntil,
        schedulerLeaseToken: ingestToken,
        claimedLeaseOwner: 'foreground',
        now: new Date('2026-05-17T04:10:01.000Z'),
      })
    ).resolves.toMatchObject({ imageEtag: ingestEtag });

    schedulerMayContinue.resolve();
    await expect(scheduler).rejects.toThrow('动态刷新 lease 已被其它 worker 接管');
    expect(harness.content.dynamicData).toEqual({ source: 'ingest' });
    expect(harness.content).toMatchObject({
      imageEtag: ingestEtag,
      dynamicRefreshLeaseUntil: null,
      dynamicRefreshLeaseToken: null,
    });
  });

  it('garbage-collects only stale unreferenced UUID and canonical frame candidates', async () => {
    const harness = createIntegrationHarness({
      renderFrame: async (_ctx, target) => Buffer.alloc(target.byteLength, 0xa1),
    });
    const oldDate = new Date('2026-05-15T04:10:00.000Z');
    const recentDate = new Date('2026-05-17T03:30:00.000Z');
    const now = new Date('2026-05-17T04:10:00.000Z');
    const staleOrphanKey = harness.blob.frameCandidateKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId,
      '11111111-1111-4111-8111-111111111111'
    );
    const staleReferencedKey = harness.blob.frameCandidateKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId,
      '22222222-2222-4222-8222-222222222222'
    );
    const recentOrphanKey = harness.blob.frameCandidateKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId,
      '33333333-3333-4333-8333-333333333333'
    );
    const staleCanonicalOrphanKey = harness.blob.frameKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId
    );
    const migratedLegacyKey = 'group-1/content-1.img';
    await harness.blob.writeStorageKey(staleOrphanKey, 'frame', Buffer.from('stale-orphan'));
    await harness.blob.writeStorageKey(staleReferencedKey, 'frame', Buffer.from('stale-ref'));
    await harness.blob.writeStorageKey(recentOrphanKey, 'frame', Buffer.from('recent-orphan'));
    await harness.blob.writeStorageKey(staleCanonicalOrphanKey, 'frame', Buffer.from('canonical'));
    await harness.blob.write('group-1', 'content-1', 'image', Buffer.from('legacy'));
    await utimes(harness.blob.storagePath(staleOrphanKey), oldDate, oldDate);
    await utimes(harness.blob.storagePath(staleReferencedKey), oldDate, oldDate);
    await utimes(harness.blob.storagePath(recentOrphanKey), recentDate, recentDate);
    await utimes(harness.blob.storagePath(staleCanonicalOrphanKey), oldDate, oldDate);
    await utimes(harness.blob.storagePath(migratedLegacyKey), oldDate, oldDate);
    harness.variants.seed(
      readyStoredVariant(NOTE4_RENDER_TARGET, {
        storageKey: staleReferencedKey,
        renderVersion: 8,
      })
    );

    await expect(harness.service.cleanupStaleDynamicRenderCandidates(now)).resolves.toBe(2);

    expect(await harness.blob.readStorageKey(staleOrphanKey)).toBeNull();
    expect(await harness.blob.readStorageKey(staleReferencedKey)).toEqual(Buffer.from('stale-ref'));
    expect(await harness.blob.readStorageKey(recentOrphanKey)).toEqual(
      Buffer.from('recent-orphan')
    );
    expect(await harness.blob.readStorageKey(staleCanonicalOrphanKey)).toBeNull();
    expect(await harness.blob.readStorageKey(migratedLegacyKey)).toEqual(Buffer.from('legacy'));
  });

  it('preserves a scan-stale key that is touched again before GC deletion', async () => {
    const harness = createIntegrationHarness({
      renderFrame: async (_ctx, target) => Buffer.alloc(target.byteLength, 0xa1),
    });
    const oldDate = new Date('2026-05-15T04:10:00.000Z');
    const touchedAt = new Date('2026-05-17T04:10:00.000Z');
    const now = new Date('2026-05-17T04:10:00.000Z');
    const key = harness.blob.frameCandidateKey(
      'group-1',
      'content-1',
      NOTE4_RENDER_TARGET.profileId,
      '44444444-4444-4444-8444-444444444444'
    );
    await harness.blob.writeStorageKey(key, 'frame', Buffer.from('scan-stale'));
    await utimes(harness.blob.storagePath(key), oldDate, oldDate);
    const originalDeleteIfOlderThan = harness.blob.deleteStorageKeyIfOlderThan.bind(harness.blob);
    let deleteAttempted = false;
    harness.blob.deleteStorageKeyIfOlderThan = async (storageKey, kind, olderThan) => {
      deleteAttempted = true;
      await harness.blob.touchStorageKey(storageKey, kind, touchedAt);
      return originalDeleteIfOlderThan(storageKey, kind, olderThan);
    };

    await expect(harness.service.cleanupStaleDynamicRenderCandidates(now)).resolves.toBe(0);

    expect(deleteAttempted).toBe(true);
    expect(await harness.blob.readStorageKey(key)).toEqual(Buffer.from('scan-stale'));
  });

  it('advances stale candidate GC past a referenced prefix to delete a later orphan', async () => {
    const harness = createIntegrationHarness({
      renderFrame: async (_ctx, target) => Buffer.alloc(target.byteLength, 0xa1),
    });
    const oldDate = new Date('2026-05-15T04:10:00.000Z');
    const now = new Date('2026-05-17T04:10:00.000Z');
    const keys: string[] = [];
    for (let index = 1; index <= 51; index++) {
      const contentId = `content-${String(index).padStart(3, '0')}`;
      const token = `${String(index).padStart(8, '0')}-1111-4111-8111-${String(index).padStart(
        12,
        '0'
      )}`;
      const key = harness.blob.frameCandidateKey(
        'group-1',
        contentId,
        NOTE4_RENDER_TARGET.profileId,
        token
      );
      keys.push(key);
      await harness.blob.writeStorageKey(key, 'frame', Buffer.from(key));
      await utimes(harness.blob.storagePath(key), oldDate, oldDate);
      if (index <= 50) {
        harness.variants.seed(
          readyStoredVariant(NOTE4_RENDER_TARGET, {
            id: `seed-${contentId}`,
            contentId,
            storageKey: key,
            renderVersion: 1,
          })
        );
      }
    }

    let deleted = 0;
    for (let attempt = 0; attempt < 10 && deleted === 0; attempt++) {
      deleted += await harness.service.cleanupStaleDynamicRenderCandidates(now);
    }

    expect(deleted).toBe(1);
    expect(await harness.blob.readStorageKey(keys[50]!)).toBeNull();
    expect(await harness.blob.readStorageKey(keys[0]!)).toEqual(Buffer.from(keys[0]!));
  });
});

function createService(opts: {
  fetchData: () => Promise<unknown>;
  renderFrame?: DynamicFrameRendererService['render'];
  variantResults?: VariantRenderService['renderContentVariantCandidates'];
  storageBytes?: Record<string, Buffer>;
  syncAudio?: () => Promise<boolean>;
  audioEtag?: string | null;
  currentAudioEtag?: string | null;
  dynamicData?: unknown;
  dynamicLastRunAt?: Date | null;
  dynamicRefreshLeaseUntil?: Date | null;
  dynamicRefreshLeaseToken?: string | null;
  imageSize?: number;
  imageEtag?: string;
  ownerUserId?: string;
  failContentFindUniqueOnce?: string;
  beforeContentFindUniqueError?: (content: {
    dynamicRefreshLeaseUntil: Date | null;
    dynamicRefreshLeaseToken: string | null;
  }) => void;
}): DynamicContentRendererService & { harness: DynamicRendererHarness } {
  const harness: DynamicRendererHarness = {
    fetchCalls: 0,
    legacyWrites: [],
    contentUpdates: [],
    renderTargets: [],
    content: null as never,
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
    dynamicRefreshLeaseUntil: opts.dynamicRefreshLeaseUntil ?? null,
    dynamicRefreshLeaseToken: opts.dynamicRefreshLeaseToken ?? null,
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
        if (opts.failContentFindUniqueOnce) {
          const message = opts.failContentFindUniqueOnce;
          opts.failContentFindUniqueOnce = undefined;
          opts.beforeContentFindUniqueError?.(content);
          throw new Error(message);
        }
        return content;
      },
      update: async (args: { data: Record<string, unknown> }) => {
        harness.contentUpdates.push(args);
        Object.assign(content, args.data);
        return content;
      },
      updateMany: async (args: {
        where: {
          id: string;
          kind?: string;
          dynamicRefreshLeaseUntil?: Date;
          dynamicRefreshLeaseToken?: string;
          OR?: Array<{ dynamicRefreshLeaseUntil: null | { lte: Date } }>;
        };
        data: Record<string, unknown>;
      }) => {
        harness.contentUpdates.push(args);
        if (
          args.where.id !== content.id ||
          (args.where.kind && args.where.kind !== content.kind) ||
          (args.where.dynamicRefreshLeaseUntil &&
            content.dynamicRefreshLeaseUntil?.getTime() !==
              args.where.dynamicRefreshLeaseUntil.getTime()) ||
          (args.where.dynamicRefreshLeaseToken &&
            content.dynamicRefreshLeaseToken !== args.where.dynamicRefreshLeaseToken) ||
          (args.where.OR && !leasePredicateMatches(args.where.OR, content.dynamicRefreshLeaseUntil))
        ) {
          return { count: 0 };
        }
        Object.assign(content, args.data);
        return { count: 1 };
      },
    },
    contentVariant: {
      findMany: async () => [],
      findUnique: async () => null,
      upsert: async (args: { create: unknown; update: unknown }) => args.create ?? args.update,
      deleteMany: async () => ({ count: 0 }),
      createMany: async (args: { data: unknown[] }) => ({ count: args.data.length }),
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn({
        $queryRaw: async () => [{ id: 'group-1' }],
        content: prisma.content,
        contentVariant: prisma.contentVariant,
      }),
  };
  const blob = {
    read: async () => null,
    write: async (groupId: string, contentId: string, kind: 'image', bytes: Buffer) => {
      harness.legacyWrites.push({ groupId, contentId, kind, bytes });
    },
    delete: async () => undefined,
    readStorageKey: async (key: string) => storageBytes[key] ?? null,
    deleteStorageKey: async (key: string) => {
      delete storageBytes[key];
    },
    frameCandidateKey: (
      groupId: string,
      contentId: string,
      profileId: string,
      attemptToken: string
    ) => `frames/${profileId}/${groupId}/${contentId}.${attemptToken}.img`,
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
    renderContentVariantCandidates:
      opts.variantResults ??
      (async (input) => {
        const note4 = await input.render(NOTE4_RENDER_TARGET);
        const storageKey = `frames/${NOTE4_RENDER_TARGET.profileId}/group-1/content-1.${input.attemptToken}.img`;
        storageBytes[storageKey] = note4;
        return {
          contentId: input.contentId,
          renderVersion: 1,
          results: [readyVariant(NOTE4_RENDER_TARGET.profileId, note4, storageKey)],
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
  service.harness.content = content;
  return service;
}

interface DynamicRendererHarness {
  fetchCalls: number;
  legacyWrites: Array<{ groupId: string; contentId: string; kind: 'image'; bytes: Buffer }>;
  contentUpdates: Array<{ where?: Record<string, unknown>; data: Record<string, unknown> }>;
  renderTargets: RenderTarget[];
  content: { dynamicRefreshLeaseUntil: Date | null; dynamicRefreshLeaseToken: string | null };
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
  dynamicRefreshLeaseToken?: string | null;
  dynamicRefreshAttempts?: number;
  dynamicLastError?: string | null;
  dynamicType?: string;
  failNextContentUpdate?: string;
  failRecomputeGroupEtags?: string;
  audioEtag?: string | null;
}) {
  const content: IntegrationContent = {
    id: 'content-1',
    groupId: 'group-1',
    frameName: null,
    kind: 'dynamic',
    dynamicType: opts.dynamicType ?? 'weather',
    dynamicConfig: {},
    dynamicData: opts.dynamicData ?? null,
    dynamicLastRunAt: opts.dynamicLastRunAt ?? null,
    dynamicNextRunAt: opts.dynamicNextRunAt ?? new Date('2026-05-17T04:15:00.000Z'),
    dynamicRefreshDueAt: opts.dynamicRefreshDueAt ?? new Date('2026-05-17T04:15:00.000Z'),
    dynamicRefreshLeaseUntil: opts.dynamicRefreshLeaseUntil ?? null,
    dynamicRefreshLeaseToken: opts.dynamicRefreshLeaseToken ?? null,
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
  let lastTransactionOps: string[] = [];
  let deletedVariantStorageKeys: string[] = [];
  const contentUpdates: Array<{ data: Partial<IntegrationContent> }> = [];
  let beforeContentUpdate: (() => void | Promise<void>) | null = null;
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
        await beforeContentUpdate?.();
        beforeContentUpdate = null;
        contentUpdates.push(args);
        if (opts.failNextContentUpdate) {
          const message = opts.failNextContentUpdate;
          opts.failNextContentUpdate = undefined;
          throw new Error(message);
        }
        Object.assign(content, args.data);
        return cloneIntegrationContent(content);
      },
      updateMany: async (args: {
        where: {
          id: string;
          kind?: string;
          dynamicRefreshLeaseUntil?: Date;
          dynamicRefreshLeaseToken?: string;
          OR?: Array<{ dynamicRefreshLeaseUntil: null | { lte: Date } }>;
        };
        data: Partial<IntegrationContent>;
      }) => {
        if (!contentExists) throw new Error('content missing');
        await beforeContentUpdate?.();
        beforeContentUpdate = null;
        contentUpdates.push(args);
        if (
          args.where.id !== content.id ||
          (args.where.kind && args.where.kind !== content.kind) ||
          (args.where.dynamicRefreshLeaseUntil &&
            content.dynamicRefreshLeaseUntil?.getTime() !==
              args.where.dynamicRefreshLeaseUntil.getTime()) ||
          (args.where.dynamicRefreshLeaseToken &&
            content.dynamicRefreshLeaseToken !== args.where.dynamicRefreshLeaseToken) ||
          (args.where.OR && !leasePredicateMatches(args.where.OR, content.dynamicRefreshLeaseUntil))
        ) {
          return { count: 0 };
        }
        if (
          opts.failNextContentUpdate &&
          Object.hasOwn(args.data, 'dynamicRefreshLeaseUntil') &&
          args.data.dynamicRefreshLeaseUntil === null
        ) {
          const message = opts.failNextContentUpdate;
          opts.failNextContentUpdate = undefined;
          throw new Error(message);
        }
        Object.assign(content, args.data);
        return { count: 1 };
      },
      findMany: async () => [],
      delete: async (args: { where: { id: string } }) => {
        if (args.where.id !== content.id || !contentExists) throw new Error('content missing');
        contentExists = false;
        source = null;
        deletedVariantStorageKeys = variants
          .rowsFor(args.where.id)
          .flatMap((variant) => (variant.storageKey ? [variant.storageKey] : []));
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
      const transactionOps: string[] = [];
      lastTransactionOps = transactionOps;
      return fn({
        $queryRaw: async () => {
          transactionOps.push('$queryRaw');
          return [{ id: 'group-1' }];
        },
        $executeRaw: async () => 0,
        content: {
          ...prisma.content,
          updateMany: async (...args: Parameters<typeof prisma.content.updateMany>) => {
            transactionOps.push('content.updateMany');
            return prisma.content.updateMany(...args);
          },
        },
        contentSource: prisma.contentSource,
        contentVariant: {
          ...variants.transactionClient,
          findMany: async (...args: Parameters<typeof variants.transactionClient.findMany>) => {
            transactionOps.push('contentVariant.findMany');
            return variants.transactionClient.findMany(...args);
          },
          findUnique: async (...args: Parameters<typeof variants.transactionClient.findUnique>) => {
            transactionOps.push('contentVariant.findUnique');
            return variants.transactionClient.findUnique(...args);
          },
          upsert: async (...args: Parameters<typeof variants.transactionClient.upsert>) => {
            transactionOps.push('contentVariant.upsert');
            return variants.transactionClient.upsert(...args);
          },
        },
      });
    },
  };
  const blob = new BlobService({ nodeEnv: 'test', blobDir } as AppConfig);
  const registry = {
    get: () => ({
      type: content.dynamicType,
      definition: { default_ttl_sec: 300 },
      provider: {
        type: content.dynamicType,
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
    recomputeGroupEtags: async () => {
      if (opts.failRecomputeGroupEtags) throw new Error(opts.failRecomputeGroupEtags);
      return {
        structureEtag: 'structure-etag',
        manifestEtag: 'group-etag',
        contentEtags: [{ id: 'content-1', etag: 'content-etag', previousEtag: 'old-content-etag' }],
      };
    },
  };
  const dynamicAudio = {
    sync: async () => false,
  };
  const sharedCoordinator = new ContentMutationCoordinator();
  const makeService = (serviceOpts: { isolated?: boolean } = {}) => {
    const coordinator = serviceOpts.isolated ? new ContentMutationCoordinator() : sharedCoordinator;
    const variantRenderer = new VariantRenderService(
      prisma as unknown as PrismaService,
      blob,
      {
        nodeEnv: 'test',
        blobDir,
      } as AppConfig,
      coordinator
    );
    return new DynamicContentRendererService(
      prisma as unknown as PrismaService,
      blob,
      registry as unknown as DynamicContentRegistry,
      frameRenderer as unknown as DynamicFrameRendererService,
      variantRenderer,
      groups as unknown as GroupsService,
      dynamicAudio as unknown as DynamicAudioService,
      coordinator
    );
  };
  const service = makeService();
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
    {} as never,
    sharedCoordinator
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
    makeService,
    variants,
    get transactionCount() {
      return transactionCount;
    },
    get lastTransactionOps() {
      return lastTransactionOps;
    },
    get deletedVariantStorageKeys() {
      return deletedVariantStorageKeys;
    },
    contentUpdates,
    get beforeContentUpdate() {
      return beforeContentUpdate;
    },
    set beforeContentUpdate(value: (() => void | Promise<void>) | null) {
      beforeContentUpdate = value;
    },
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
  dynamicRefreshLeaseToken: string | null;
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
    findMany: async (args: {
      where: { contentId?: string; storageKey?: string | { in: string[] } };
    }) => {
      this.findManyCalls++;
      if (this.findManyFailure?.call === this.findManyCalls) {
        const err = this.findManyFailure.error;
        this.findManyFailure = null;
        throw err;
      }
      return [...this.rows.values()]
        .filter((row) => {
          if (args.where.contentId !== undefined && row.contentId !== args.where.contentId) {
            return false;
          }
          if (args.where.storageKey !== undefined) {
            if (typeof args.where.storageKey === 'string') {
              if (row.storageKey !== args.where.storageKey) return false;
            } else if (!row.storageKey || !args.where.storageKey.in.includes(row.storageKey)) {
              return false;
            }
          }
          return true;
        })
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
    deleteMany: async (args: {
      where: { contentId: string; profileId?: { in: string[] }; renderVersion?: number };
    }) => {
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
    deleteMany: async (args: {
      where: { contentId: string; profileId?: { in: string[] }; renderVersion?: number };
    }) => this.deleteMany(args),
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

  private async deleteMany(args: {
    where: { contentId: string; profileId?: { in: string[] }; renderVersion?: number };
  }) {
    let count = 0;
    for (const row of [...this.rows.values()]) {
      if (row.contentId !== args.where.contentId) continue;
      if (args.where.profileId && !args.where.profileId.in.includes(row.profileId)) continue;
      if (
        args.where.renderVersion !== undefined &&
        row.renderVersion !== args.where.renderVersion
      ) {
        continue;
      }
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
    dynamicRefreshLeaseToken: content.dynamicRefreshLeaseToken,
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

function leasePredicateMatches(
  predicates: Array<{ dynamicRefreshLeaseUntil: null | { lte: Date } }>,
  leaseUntil: Date | null
): boolean {
  return predicates.some((predicate) => {
    if (predicate.dynamicRefreshLeaseUntil === null) return leaseUntil === null;
    return (
      leaseUntil !== null &&
      leaseUntil.getTime() <= predicate.dynamicRefreshLeaseUntil.lte.getTime()
    );
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
