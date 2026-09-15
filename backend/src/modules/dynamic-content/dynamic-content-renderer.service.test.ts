import { describe, expect, it } from 'bun:test';
import { FRAME_BYTES } from 'shared';
import { computeETag } from '../../common/utils/etag';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { BlobService } from '../../infra/blob/blob.service';
import type { GroupsService } from '../groups/groups.service';
import type { DynamicFrameRendererService } from './rendering/dynamic-frame-renderer.service';
import type { DynamicAudioService } from './audio/dynamic-audio.service';
import type { DynamicContentRegistry } from './dynamic-content-registry';
import { DynamicContentRendererService } from './dynamic-content-renderer.service';
import type { VariantRenderService } from '../rendering/variant-render.service';
import {
  NOTE4_RENDER_TARGET,
  renderTargetForProfile,
  type RenderTarget,
} from '../rendering/render-target';

const VIRTUAL_RENDER_TARGET = renderTargetForProfile('virtual-mono-296x128');

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

  it('preserves the old legacy frame when Note4 fails but a previous ready Note4 variant exists', async () => {
    const oldNote4Bytes = Buffer.alloc(NOTE4_RENDER_TARGET.byteLength, 0x44);
    const oldEtag = computeETag(oldNote4Bytes);
    const service = createService({
      fetchData: async () => ({ tempC: 23 }),
      imageEtag: oldEtag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      variantResults: async () => ({
        contentId: 'content-1',
        renderVersion: 2,
        results: [
          {
            profileId: NOTE4_RENDER_TARGET.profileId,
            status: 'ready',
            changed: false,
            frameEtag: oldEtag,
            frameSize: NOTE4_RENDER_TARGET.byteLength,
            storageKey: 'old-note4-key',
            renderVersion: 1,
            error: 'note4 renderer failed',
          },
          {
            profileId: VIRTUAL_RENDER_TARGET.profileId,
            status: 'ready',
            changed: true,
            frameEtag: 'virtual-etag',
            frameSize: VIRTUAL_RENDER_TARGET.byteLength,
            storageKey: 'virtual-key',
            renderVersion: 2,
          },
        ],
      }),
      storageBytes: {
        'old-note4-key': oldNote4Bytes,
      },
    });

    await expect(service.renderDynamicContent('content-1', { force: true })).resolves.toMatchObject(
      {
        imageEtag: oldEtag,
        unchanged: false,
      }
    );
    expect(service.harness.legacyWrites.at(-1)?.bytes).toBe(oldNote4Bytes);
    expect(service.harness.contentUpdates.at(-1)?.data).toMatchObject({
      imageEtag: oldEtag,
      imageSize: NOTE4_RENDER_TARGET.byteLength,
      dynamicRefreshAttempts: 0,
    });
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
    expect(service.harness.contentUpdates).toEqual([]);
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

  it('rejects unsupported preview display profiles', async () => {
    const service = createService({
      fetchData: async () => ({ tempC: 21 }),
    });

    await expect(
      service.renderPreviewDirect('weather', {}, null, { tempC: 21 }, 'missing-profile')
    ).rejects.toThrow();
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
  reject: (err: Error) => void;
} {
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((_, rejectFn) => {
    reject = rejectFn;
  });
  return { promise, reject };
}
