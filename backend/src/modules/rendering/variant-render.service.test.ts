import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import { BlobService } from '../../infra/blob/blob.service';
import type { AppConfig } from '../../infra/config/app.config';
import { VariantRenderService } from './variant-render.service';
import type { RenderTarget } from './render-target';
import type { DisplayProfileT } from 'shared';

const NOTE4_PROFILE = 'zectrix-note4-400x300-mono';
const VIRTUAL_PROFILE = 'virtual-mono-296x128';

let blobDir = '/tmp/slatehub-variant-render-test';

beforeEach(async () => {
  blobDir = await mkdtemp(join(tmpdir(), 'slatehub-variant-render-test-'));
});

afterEach(async () => {
  await rm(blobDir, { recursive: true, force: true });
});

describe('VariantRenderService', () => {
  it('renders only physical production profiles while development and test include virtual profiles', async () => {
    const production = await createHarness('production').service.renderContentVariants({
      groupId: 'group-1',
      contentId: 'content-1',
      render: (target) => Buffer.alloc(target.byteLength, 0x11),
    });
    const development = await createHarness('development').service.renderContentVariants({
      groupId: 'group-1',
      contentId: 'content-1',
      render: (target) => Buffer.alloc(target.byteLength, 0x22),
    });
    const test = await createHarness('test').service.renderContentVariants({
      groupId: 'group-1',
      contentId: 'content-1',
      render: (target) => Buffer.alloc(target.byteLength, 0x33),
    });

    expect(production.results.map((result) => result.profileId)).toEqual([NOTE4_PROFILE]);
    expect(development.results.map((result) => result.profileId)).toEqual([
      NOTE4_PROFILE,
      VIRTUAL_PROFILE,
    ]);
    expect(test.results.map((result) => result.profileId)).toEqual([
      NOTE4_PROFILE,
      VIRTUAL_PROFILE,
    ]);
  });

  it('persists exact profile sizes, isolated storage keys, and one render version for a multi-profile render', async () => {
    const harness = createHarness('test');

    const outcome = await harness.service.renderContentVariants({
      groupId: 'group-1',
      contentId: 'content-1',
      render: (target) =>
        Buffer.alloc(target.byteLength, target.profileId === NOTE4_PROFILE ? 1 : 2),
    });

    expect(outcome.results).toEqual([
      {
        profileId: NOTE4_PROFILE,
        status: 'ready',
        changed: true,
        frameEtag: expect.any(String),
        frameSize: 15_000,
        storageKey: 'frames/zectrix-note4-400x300-mono/group-1/content-1.img',
        renderVersion: 1,
      },
      {
        profileId: VIRTUAL_PROFILE,
        status: 'ready',
        changed: true,
        frameEtag: expect.any(String),
        frameSize: 4_736,
        storageKey: 'frames/virtual-mono-296x128/group-1/content-1.img',
        renderVersion: 1,
      },
    ]);
    expect(harness.store.row('content-1', NOTE4_PROFILE)).toMatchObject({
      status: 'ready',
      pixelFormat: 'mono1',
      frameCodec: 'raw_mono1_msb',
      width: 400,
      height: 300,
      frameSize: 15_000,
      storageKey: 'frames/zectrix-note4-400x300-mono/group-1/content-1.img',
      renderVersion: 1,
      lastError: null,
      leaseUntil: null,
      attempts: 0,
    });
    expect(harness.store.row('content-1', VIRTUAL_PROFILE)).toMatchObject({
      status: 'ready',
      pixelFormat: 'mono1',
      frameCodec: 'raw_mono1_msb',
      width: 296,
      height: 128,
      frameSize: 4_736,
      storageKey: 'frames/virtual-mono-296x128/group-1/content-1.img',
      renderVersion: 1,
      lastError: null,
      leaseUntil: null,
      attempts: 0,
    });
    expect(
      await harness.blob.readStorageKey('frames/zectrix-note4-400x300-mono/group-1/content-1.img')
    ).toEqual(Buffer.alloc(15_000, 1));
    expect(
      await harness.blob.readStorageKey('frames/virtual-mono-296x128/group-1/content-1.img')
    ).toEqual(Buffer.alloc(4_736, 2));
  });

  it('serializes complete render transitions per content so the later render owns the final blob and version', async () => {
    const harness = createHarness('production');
    const firstRenderStarted = deferred<void>();
    const firstRenderMayFinish = deferred<void>();
    let renderCalls = 0;

    const first = harness.service.renderContentVariants({
      groupId: 'group-1',
      contentId: 'content-1',
      render: async (target) => {
        renderCalls++;
        firstRenderStarted.resolve();
        await firstRenderMayFinish.promise;
        return Buffer.alloc(target.byteLength, 0x11);
      },
    });
    await firstRenderStarted.promise;

    const second = harness.service.renderContentVariants({
      groupId: 'group-1',
      contentId: 'content-1',
      render: (target) => {
        renderCalls++;
        return Buffer.alloc(target.byteLength, 0x22);
      },
    });

    await Promise.resolve();
    expect(renderCalls).toBe(1);
    firstRenderMayFinish.resolve();

    await expect(first).resolves.toMatchObject({
      renderVersion: 1,
      results: [expect.objectContaining({ profileId: NOTE4_PROFILE, renderVersion: 1 })],
    });
    await expect(second).resolves.toMatchObject({
      renderVersion: 2,
      results: [expect.objectContaining({ profileId: NOTE4_PROFILE, renderVersion: 2 })],
    });

    const key = harness.blob.frameKey('group-1', 'content-1', NOTE4_PROFILE);
    const finalBytes = await harness.blob.readStorageKey(key);
    expect(finalBytes).toEqual(Buffer.alloc(15_000, 0x22));
    expect(harness.store.row('content-1', NOTE4_PROFILE)).toMatchObject({
      status: 'ready',
      frameEtag: etagFor(Buffer.alloc(15_000, 0x22)),
      frameSize: 15_000,
      storageKey: key,
      renderVersion: 2,
      attempts: 0,
    });
  });

  it('runs a queued retry after an earlier whole-transition version read fails', async () => {
    const harness = createHarness('production');
    harness.store.failNextVersionRead('version db down');
    let renderCalls = 0;

    const first = harness.service.renderContentVariants({
      groupId: 'group-1',
      contentId: 'content-1',
      render: (target) => {
        renderCalls++;
        return Buffer.alloc(target.byteLength, 0x66);
      },
    });
    const second = harness.service.renderContentVariants({
      groupId: 'group-1',
      contentId: 'content-1',
      render: (target) => {
        renderCalls++;
        return Buffer.alloc(target.byteLength, 0x77);
      },
    });

    await expect(first).rejects.toThrow('version db down');
    await expect(second).resolves.toMatchObject({
      renderVersion: 1,
      results: [expect.objectContaining({ profileId: NOTE4_PROFILE, status: 'ready' })],
    });

    const key = harness.blob.frameKey('group-1', 'content-1', NOTE4_PROFILE);
    expect(harness.store.findManyCalls).toBe(2);
    expect(renderCalls).toBe(1);
    expect(await harness.blob.readStorageKey(key)).toEqual(Buffer.alloc(15_000, 0x77));
    expect(harness.store.row('content-1', NOTE4_PROFILE)).toMatchObject({
      status: 'ready',
      frameEtag: etagFor(Buffer.alloc(15_000, 0x77)),
      frameSize: 15_000,
      storageKey: key,
      renderVersion: 1,
      attempts: 0,
    });
  });

  it('commits successful profiles even when another profile render fails', async () => {
    const harness = createHarness('test');

    const outcome = await harness.service.renderContentVariants({
      groupId: 'group-1',
      contentId: 'content-1',
      render: (target) => {
        if (target.profileId === VIRTUAL_PROFILE) throw new Error('virtual renderer failed');
        return Buffer.alloc(target.byteLength, 0xaa);
      },
    });

    expect(outcome.results).toEqual([
      expect.objectContaining({ profileId: NOTE4_PROFILE, status: 'ready', changed: true }),
      expect.objectContaining({
        profileId: VIRTUAL_PROFILE,
        status: 'failed',
        changed: true,
        error: 'virtual renderer failed',
      }),
    ]);
    expect(harness.store.row('content-1', NOTE4_PROFILE)).toMatchObject({
      status: 'ready',
      frameSize: 15_000,
      attempts: 0,
    });
    expect(harness.store.row('content-1', VIRTUAL_PROFILE)).toMatchObject({
      status: 'failed',
      frameEtag: null,
      frameSize: null,
      storageKey: null,
      attempts: 1,
      lastError: 'virtual renderer failed',
    });
  });

  it('continues rendering later profiles when failed-state persistence fails for one profile', async () => {
    const harness = createHarness('test');
    harness.store.failNextWrite('failed row db down');

    const outcome = await harness.service.renderContentVariants({
      groupId: 'group-1',
      contentId: 'content-1',
      render: (target) => {
        if (target.profileId === NOTE4_PROFILE) throw new Error('note4 renderer failed');
        return Buffer.alloc(target.byteLength, 0xbb);
      },
    });

    expect(outcome.results).toEqual([
      {
        profileId: NOTE4_PROFILE,
        status: 'failed',
        changed: false,
        error: 'failed row db down',
      },
      expect.objectContaining({
        profileId: VIRTUAL_PROFILE,
        status: 'ready',
        changed: true,
        frameSize: 4_736,
      }),
    ]);
    expect(harness.store.row('content-1', VIRTUAL_PROFILE)).toMatchObject({
      status: 'ready',
      frameSize: 4_736,
      attempts: 0,
    });
  });

  it('reports target-resolution failure for one profile and continues rendering later profiles', async () => {
    const harness = createHarness('test', { failTargetProfile: NOTE4_PROFILE });

    const outcome = await harness.service.renderContentVariants({
      groupId: 'group-1',
      contentId: 'content-1',
      render: (target) => Buffer.alloc(target.byteLength, 0xcc),
    });

    expect(outcome.results).toEqual([
      {
        profileId: NOTE4_PROFILE,
        status: 'failed',
        changed: false,
        error: 'target resolution failed',
      },
      expect.objectContaining({
        profileId: VIRTUAL_PROFILE,
        status: 'ready',
        changed: true,
        frameSize: 4_736,
      }),
    ]);
    expect(harness.store.row('content-1', VIRTUAL_PROFILE)).toMatchObject({
      status: 'ready',
      frameSize: 4_736,
    });
  });

  it('reports prior-read failure for one profile and continues rendering later profiles', async () => {
    const harness = createHarness('test');
    harness.store.failNextRead(NOTE4_PROFILE, 'prior read db down');

    const outcome = await harness.service.renderContentVariants({
      groupId: 'group-1',
      contentId: 'content-1',
      render: (target) => Buffer.alloc(target.byteLength, 0xdd),
    });

    expect(outcome.results).toEqual([
      {
        profileId: NOTE4_PROFILE,
        status: 'failed',
        changed: false,
        error: 'prior read db down',
      },
      expect.objectContaining({
        profileId: VIRTUAL_PROFILE,
        status: 'ready',
        changed: true,
        frameSize: 4_736,
      }),
    ]);
    expect(harness.store.row('content-1', VIRTUAL_PROFILE)).toMatchObject({
      status: 'ready',
      frameSize: 4_736,
    });
  });

  it('keeps previous ready bytes and metadata when rendering that profile fails', async () => {
    const harness = createHarness('production');
    const key = harness.blob.frameKey('group-1', 'content-1', NOTE4_PROFILE);
    await harness.blob.writeStorageKey(key, 'frame', Buffer.alloc(15_000, 0x44));
    harness.store.seed({
      contentId: 'content-1',
      profileId: NOTE4_PROFILE,
      status: 'ready',
      pixelFormat: 'mono1',
      frameCodec: 'raw_mono1_msb',
      width: 400,
      height: 300,
      frameEtag: 'old-etag',
      frameSize: 15_000,
      storageKey: key,
      renderVersion: 7,
      lastError: null,
      leaseUntil: new Date('2026-01-01T00:00:00.000Z'),
      attempts: 2,
    });

    const outcome = await harness.service.renderContentVariants({
      groupId: 'group-1',
      contentId: 'content-1',
      render: () => {
        throw new Error('source unavailable');
      },
    });

    expect(outcome.results).toEqual([
      {
        profileId: NOTE4_PROFILE,
        status: 'ready',
        changed: false,
        frameEtag: 'old-etag',
        frameSize: 15_000,
        storageKey: key,
        renderVersion: 7,
        error: 'source unavailable',
      },
    ]);
    expect(harness.store.row('content-1', NOTE4_PROFILE)).toMatchObject({
      status: 'ready',
      frameEtag: 'old-etag',
      frameSize: 15_000,
      storageKey: key,
      renderVersion: 7,
      lastError: 'source unavailable',
      leaseUntil: null,
      attempts: 3,
    });
    expect(await harness.blob.readStorageKey(key)).toEqual(Buffer.alloc(15_000, 0x44));
  });

  it('preserves stale ready descriptor metadata when rendering that profile fails', async () => {
    const harness = createHarness('production');
    const key = harness.blob.frameKey('group-1', 'content-1', NOTE4_PROFILE);
    await harness.blob.writeStorageKey(key, 'frame', Buffer.alloc(15_000, 0x45));
    harness.store.seed({
      contentId: 'content-1',
      profileId: NOTE4_PROFILE,
      status: 'ready',
      pixelFormat: 'legacy-mono',
      frameCodec: 'legacy-codec',
      width: 123,
      height: 456,
      frameEtag: 'stale-etag',
      frameSize: 1234,
      storageKey: key,
      renderVersion: 9,
      lastError: null,
      leaseUntil: new Date('2026-01-01T00:00:00.000Z'),
      attempts: 4,
    });

    await harness.service.renderContentVariants({
      groupId: 'group-1',
      contentId: 'content-1',
      render: () => {
        throw new Error('renderer offline');
      },
    });

    expect(harness.store.row('content-1', NOTE4_PROFILE)).toMatchObject({
      status: 'ready',
      pixelFormat: 'legacy-mono',
      frameCodec: 'legacy-codec',
      width: 123,
      height: 456,
      frameEtag: 'stale-etag',
      frameSize: 1234,
      storageKey: key,
      renderVersion: 9,
      lastError: 'renderer offline',
      leaseUntil: null,
      attempts: 5,
    });
  });

  it('creates a failed variant row for first render failure and bounds the latest error', async () => {
    const harness = createHarness('production');
    const longMessage = `render failed: ${'x'.repeat(600)}`;

    const outcome = await harness.service.renderContentVariants({
      groupId: 'group-1',
      contentId: 'content-1',
      render: () => {
        throw new Error(longMessage);
      },
    });

    const row = harness.store.row('content-1', NOTE4_PROFILE);
    expect(outcome.results).toEqual([
      expect.objectContaining({
        profileId: NOTE4_PROFILE,
        status: 'failed',
        changed: true,
        error: row.lastError,
      }),
    ]);
    expect(row).toMatchObject({
      status: 'failed',
      pixelFormat: 'mono1',
      frameCodec: 'raw_mono1_msb',
      width: 400,
      height: 300,
      frameEtag: null,
      frameSize: null,
      storageKey: null,
      renderVersion: 1,
      leaseUntil: null,
      attempts: 1,
    });
    expect(row.lastError).toHaveLength(512);
    expect(row.lastError?.startsWith('render failed: xxx')).toBe(true);
  });

  it('restores previous frame bytes when database persistence fails after replacing a ready blob', async () => {
    const harness = createHarness('production');
    const key = harness.blob.frameKey('group-1', 'content-1', NOTE4_PROFILE);
    await harness.blob.writeStorageKey(key, 'frame', Buffer.alloc(15_000, 0x01));
    harness.store.seed({
      contentId: 'content-1',
      profileId: NOTE4_PROFILE,
      status: 'ready',
      pixelFormat: 'mono1',
      frameCodec: 'raw_mono1_msb',
      width: 400,
      height: 300,
      frameEtag: 'old-etag',
      frameSize: 15_000,
      storageKey: key,
      renderVersion: 1,
      lastError: null,
      leaseUntil: null,
      attempts: 0,
    });
    harness.store.failNextWrite('db down');

    const outcome = await harness.service.renderContentVariants({
      groupId: 'group-1',
      contentId: 'content-1',
      render: (target) => Buffer.alloc(target.byteLength, 0x02),
    });

    expect(outcome.results).toEqual([
      expect.objectContaining({
        profileId: NOTE4_PROFILE,
        status: 'ready',
        changed: false,
        error: 'db down',
      }),
    ]);
    expect(await harness.blob.readStorageKey(key)).toEqual(Buffer.alloc(15_000, 0x01));
  });

  it('deletes only the canonical destination when DB persistence fails for a ready row stored at a legacy key', async () => {
    const harness = createHarness('production');
    const legacyKey = 'group-1/content-1.img';
    const canonicalKey = harness.blob.frameKey('group-1', 'content-1', NOTE4_PROFILE);
    await harness.blob.write('group-1', 'content-1', 'image', Buffer.alloc(15_000, 0x07));
    harness.store.seed({
      contentId: 'content-1',
      profileId: NOTE4_PROFILE,
      status: 'ready',
      pixelFormat: 'mono1',
      frameCodec: 'raw_mono1_msb',
      width: 400,
      height: 300,
      frameEtag: 'legacy-etag',
      frameSize: 15_000,
      storageKey: legacyKey,
      renderVersion: 3,
      lastError: null,
      leaseUntil: null,
      attempts: 0,
    });
    harness.store.failNextWrite('db down');

    const outcome = await harness.service.renderContentVariants({
      groupId: 'group-1',
      contentId: 'content-1',
      render: (target) => Buffer.alloc(target.byteLength, 0x08),
    });

    expect(outcome.results).toEqual([
      expect.objectContaining({
        profileId: NOTE4_PROFILE,
        status: 'ready',
        changed: false,
        error: 'db down',
      }),
    ]);
    expect(await harness.blob.readStorageKey(legacyKey)).toEqual(Buffer.alloc(15_000, 0x07));
    expect(await harness.blob.readStorageKey(canonicalKey)).toBeNull();
  });

  it('reports rollback failure instead of returning a ready result for a corrupted destination', async () => {
    const blob = new RollbackFailingBlobService({
      nodeEnv: 'production',
      blobDir,
    } as AppConfig);
    const store = new FakeVariantStore();
    const service = new VariantRenderService(
      { contentVariant: store.client } as unknown as PrismaService,
      blob,
      { nodeEnv: 'production', blobDir } as AppConfig
    );
    const key = blob.frameKey('group-1', 'content-1', NOTE4_PROFILE);
    await blob.writeStorageKey(key, 'frame', Buffer.alloc(15_000, 0x09));
    store.seed({
      contentId: 'content-1',
      profileId: NOTE4_PROFILE,
      status: 'ready',
      pixelFormat: 'mono1',
      frameCodec: 'raw_mono1_msb',
      width: 400,
      height: 300,
      frameEtag: 'old-etag',
      frameSize: 15_000,
      storageKey: key,
      renderVersion: 1,
      lastError: null,
      leaseUntil: null,
      attempts: 0,
    });
    store.failNextWrite('db down');
    blob.failNextRollbackWrite('rollback write down');

    const outcome = await service.renderContentVariants({
      groupId: 'group-1',
      contentId: 'content-1',
      render: (target) => Buffer.alloc(target.byteLength, 0x0a),
    });

    expect(outcome.results).toEqual([
      {
        profileId: NOTE4_PROFILE,
        status: 'failed',
        changed: false,
        error: 'db down; blob rollback failed: rollback write down',
      },
    ]);
    expect(await blob.readStorageKey(key)).toEqual(Buffer.alloc(15_000, 0x0a));
    expect(store.row('content-1', NOTE4_PROFILE)).toMatchObject({
      status: 'ready',
      frameEtag: 'old-etag',
      renderVersion: 1,
      attempts: 0,
    });
  });

  it('removes a newly written frame when database persistence fails without prior bytes', async () => {
    const harness = createHarness('production');
    const key = harness.blob.frameKey('group-1', 'content-1', NOTE4_PROFILE);
    harness.store.failNextWrite('db down');

    const outcome = await harness.service.renderContentVariants({
      groupId: 'group-1',
      contentId: 'content-1',
      render: (target) => Buffer.alloc(target.byteLength, 0x03),
    });

    expect(outcome.results).toEqual([
      expect.objectContaining({
        profileId: NOTE4_PROFILE,
        status: 'failed',
        changed: false,
        error: 'db down',
      }),
    ]);
    expect(await harness.blob.readStorageKey(key)).toBeNull();
  });

  it('records frame-size validation as that profile failure and continues with other profiles', async () => {
    const harness = createHarness('test');

    const outcome = await harness.service.renderContentVariants({
      groupId: 'group-1',
      contentId: 'content-1',
      render: (target) => {
        if (target.profileId === NOTE4_PROFILE) return Buffer.alloc(target.byteLength, 0x05);
        return Buffer.alloc(12, 0x06);
      },
    });

    expect(outcome.results).toEqual([
      expect.objectContaining({ profileId: NOTE4_PROFILE, status: 'ready', changed: true }),
      expect.objectContaining({
        profileId: VIRTUAL_PROFILE,
        status: 'failed',
        changed: true,
        error: '帧大小不匹配: 当前 12 字节, 期望 4736 字节',
      }),
    ]);
    expect(harness.store.row('content-1', NOTE4_PROFILE)).toMatchObject({
      status: 'ready',
      frameSize: 15_000,
    });
    expect(harness.store.row('content-1', VIRTUAL_PROFILE)).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: '帧大小不匹配: 当前 12 字节, 期望 4736 字节',
    });
  });
});

function createHarness(nodeEnv: AppConfig['nodeEnv'], opts: { failTargetProfile?: string } = {}) {
  const config = { nodeEnv, blobDir } as AppConfig;
  const blob = new BlobService(config);
  const store = new FakeVariantStore();
  const service = new TestVariantRenderService(
    { contentVariant: store.client } as unknown as PrismaService,
    blob,
    config,
    opts
  );
  return { blob, service, store };
}

interface StoredVariant {
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
}

class FakeVariantStore {
  private readonly rows = new Map<string, StoredVariant>();
  private nextWriteError: Error | null = null;
  private nextVersionReadError: Error | null = null;
  private readonly readErrorsByProfile = new Map<string, Error>();
  findManyCalls = 0;

  readonly client = {
    findMany: async (args: { where: { contentId: string } }) => {
      this.findManyCalls++;
      if (this.nextVersionReadError) {
        const err = this.nextVersionReadError;
        this.nextVersionReadError = null;
        throw err;
      }
      return [...this.rows.values()].filter((row) => row.contentId === args.where.contentId);
    },
    findUnique: async (args: {
      where: { contentId_profileId: { contentId: string; profileId: string } };
    }) => {
      const { contentId, profileId } = args.where.contentId_profileId;
      const readError = this.readErrorsByProfile.get(profileId);
      if (readError) {
        this.readErrorsByProfile.delete(profileId);
        throw readError;
      }
      return this.rows.get(this.key(contentId, profileId)) ?? null;
    },
    upsert: async (args: {
      where: { contentId_profileId: { contentId: string; profileId: string } };
      create: StoredVariant;
      update: Partial<StoredVariant>;
    }) => {
      this.throwIfRequested();
      const { contentId, profileId } = args.where.contentId_profileId;
      const key = this.key(contentId, profileId);
      const next = { ...(this.rows.get(key) ?? args.create), ...args.update };
      this.rows.set(key, next);
      return next;
    },
  };

  seed(row: StoredVariant): void {
    this.rows.set(this.key(row.contentId, row.profileId), { ...row });
  }

  row(contentId: string, profileId: string): StoredVariant {
    const row = this.rows.get(this.key(contentId, profileId));
    if (!row) throw new Error(`missing fake variant row ${contentId}/${profileId}`);
    return row;
  }

  failNextWrite(message: string): void {
    this.nextWriteError = new Error(message);
  }

  failNextRead(profileId: string, message: string): void {
    this.readErrorsByProfile.set(profileId, new Error(message));
  }

  failNextVersionRead(message: string): void {
    this.nextVersionReadError = new Error(message);
  }

  private throwIfRequested(): void {
    if (!this.nextWriteError) return;
    const err = this.nextWriteError;
    this.nextWriteError = null;
    throw err;
  }

  private key(contentId: string, profileId: string): string {
    return `${contentId}/${profileId}`;
  }
}

class TestVariantRenderService extends VariantRenderService {
  constructor(
    prisma: PrismaService,
    blob: BlobService,
    config: AppConfig,
    private readonly opts: { failTargetProfile?: string }
  ) {
    super(prisma, blob, config);
  }

  protected override resolveRenderTarget(profile: DisplayProfileT): RenderTarget {
    if (profile.id === this.opts.failTargetProfile) throw new Error('target resolution failed');
    return super.resolveRenderTarget(profile);
  }
}

class RollbackFailingBlobService extends BlobService {
  private rollbackWriteError: Error | null = null;
  private writesBeforeRollbackFailure = 0;

  failNextRollbackWrite(message: string): void {
    this.rollbackWriteError = new Error(message);
    this.writesBeforeRollbackFailure = 1;
  }

  override async writeStorageKey(
    storageKey: string,
    kind: Parameters<BlobService['writeStorageKey']>[1],
    data: Parameters<BlobService['writeStorageKey']>[2]
  ): Promise<{ path: string; size: number }> {
    if (this.rollbackWriteError) {
      if (this.writesBeforeRollbackFailure > 0) {
        this.writesBeforeRollbackFailure--;
        return super.writeStorageKey(storageKey, kind, data);
      }
      const err = this.rollbackWriteError;
      this.rollbackWriteError = null;
      throw err;
    }
    return super.writeStorageKey(storageKey, kind, data);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveFn) => {
    resolve = resolveFn;
  });
  return { promise, resolve };
}

function etagFor(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 32);
}
