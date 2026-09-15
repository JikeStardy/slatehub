import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import { BlobService } from '../../infra/blob/blob.service';
import type { AppConfig } from '../../infra/config/app.config';
import { VariantRenderService } from './variant-render.service';
import type { RenderTarget } from './render-target';

const NOTE4_PROFILE = 'zectrix-note4-400x300-mono';
const VIRTUAL_PROFILE = 'virtual-mono-296x128';

let blobDir = '/tmp/slate-variant-render-test';

beforeEach(async () => {
  blobDir = await mkdtemp(join(tmpdir(), 'slate-variant-render-test-'));
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

  it('reports an unsupported target as that profile failure and continues with other profiles', async () => {
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

function createHarness(nodeEnv: AppConfig['nodeEnv']) {
  const config = { nodeEnv, blobDir } as AppConfig;
  const blob = new BlobService(config);
  const store = new FakeVariantStore();
  const service = new VariantRenderService(
    { contentVariant: store.client } as unknown as PrismaService,
    blob,
    config
  );
  return { blob, service, store };
}

interface StoredVariant {
  contentId: string;
  profileId: string;
  status: 'pending' | 'ready' | 'failed';
  pixelFormat: RenderTarget['pixelFormat'];
  frameCodec: RenderTarget['frameCodec'];
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

  readonly client = {
    findMany: async (args: { where: { contentId: string } }) => {
      return [...this.rows.values()].filter((row) => row.contentId === args.where.contentId);
    },
    findUnique: async (args: {
      where: { contentId_profileId: { contentId: string; profileId: string } };
    }) => {
      const { contentId, profileId } = args.where.contentId_profileId;
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
