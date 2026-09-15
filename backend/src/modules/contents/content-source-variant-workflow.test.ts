import { describe, expect, it } from 'bun:test';
import { DEFAULT_DISPLAY_PROFILE_ID } from 'shared';
import { computeETag } from '../../common/utils/etag';
import type { BlobService } from '../../infra/blob/blob.service';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import type { GroupsService } from '../groups/groups.service';
import type { ImageRendererService } from '../image-renderer/image-renderer.service';
import type { VariantRenderService } from '../rendering/variant-render.service';
import { renderTargetForProfile, type RenderTarget } from '../rendering/render-target';
import type { AudioTranscoderService } from '../audio/audio-transcoder.service';
import type { TtsService } from '../tts/tts.service';
import type { ContentAudioBlobService } from './content-audio-blob.service';
import { ContentsService } from './contents.service';

const NOTE4_PROFILE = DEFAULT_DISPLAY_PROFILE_ID;
const VIRTUAL_PROFILE = 'virtual-mono-296x128';

describe('ContentsService source and variant workflow', () => {
  it('stores original static source bytes, renders enabled variants, and mirrors Note4 to legacy fields', async () => {
    const original = Buffer.from('exact original image bytes');
    const store = new FakeContentStore();
    const blobs = new FakeBlobService();
    const renders: RenderTarget[] = [];
    const service = createContentsService({ store, blobs, renders });

    const response = await service.appendImage('group-1', 'user-1', {
      hasImage: true,
      imageBuf: original,
      hasAudio: false,
      audioBuf: null,
      hasFrameName: true,
      frameName: 'Desk',
    });

    const contentId = response.id;
    const sourceKey = blobs.sourceKey('group-1', contentId);
    const note4Key = blobs.frameKey('group-1', contentId, NOTE4_PROFILE);
    const virtualKey = blobs.frameKey('group-1', contentId, VIRTUAL_PROFILE);
    const note4Frame = Buffer.alloc(15_000, 0x11);

    expect(blobs.storage.get(sourceKey)).toEqual(original);
    expect(store.source(contentId)).toMatchObject({
      status: 'ready',
      sourceEtag: computeETag(original),
      mimeType: 'application/octet-stream',
      size: original.byteLength,
      storageKey: sourceKey,
    });
    expect(renders.map((target) => target.profileId)).toEqual([NOTE4_PROFILE, VIRTUAL_PROFILE]);
    expect(blobs.storage.get(note4Key)).toEqual(note4Frame);
    expect(blobs.storage.get(virtualKey)).toEqual(Buffer.alloc(4_736, 0x22));
    expect(blobs.legacy.get(`group-1/${contentId}.image`)).toEqual(note4Frame);
    expect(store.content(contentId)).toMatchObject({
      frameName: 'Desk',
      imageEtag: computeETag(note4Frame),
      imageSize: 15_000,
    });
    expect(response).toMatchObject({
      image_etag: computeETag(note4Frame),
      manifest_etag: 'manifest-etag-1',
      content_etag: 'content-etag-2',
    });
  });

  it('replaces legacy source-unavailable content with ready source variants and refreshed legacy mirror', async () => {
    const replacement = Buffer.from('new exact source bytes');
    const store = new FakeContentStore();
    const blobs = new FakeBlobService();
    const renders: RenderTarget[] = [];
    store.seedContent('content-1', {
      id: 'content-1',
      groupId: 'group-1',
      sortOrder: 3,
      frameName: 'Old',
      imageEtag: 'legacy-etag',
      imageSize: 123,
      audioEtag: 'old-audio',
      kind: 'image',
    });
    blobs.legacy.set('group-1/content-1.image', Buffer.from('old legacy frame'));
    const service = createContentsService({ store, blobs, renders });

    const response = await service.patchImage('content-1', 'user-1', {
      hasImage: true,
      imageBuf: replacement,
      hasAudio: false,
      audioBuf: null,
      hasFrameName: true,
      frameName: 'New',
    });

    const sourceKey = blobs.sourceKey('group-1', 'content-1');
    const note4Frame = Buffer.alloc(15_000, 0x11);
    expect(blobs.storage.get(sourceKey)).toEqual(replacement);
    expect(store.source('content-1')).toMatchObject({
      status: 'ready',
      sourceEtag: computeETag(replacement),
      size: replacement.byteLength,
      storageKey: sourceKey,
    });
    expect(renders.map((target) => target.profileId)).toEqual([NOTE4_PROFILE, VIRTUAL_PROFILE]);
    expect(blobs.legacy.get('group-1/content-1.image')).toEqual(note4Frame);
    expect(store.content('content-1')).toMatchObject({
      frameName: 'New',
      imageEtag: computeETag(note4Frame),
      imageSize: 15_000,
      audioEtag: null,
    });
    expect(response).toMatchObject({
      seq: 3,
      image_etag: computeETag(note4Frame),
      audio_etag: null,
    });
  });

  it('does not rewrite source or rerender variants for frame-name and audio-only patches', async () => {
    const source = Buffer.from('existing source');
    const sourceEtag = computeETag(source);
    const store = new FakeContentStore();
    const blobs = new FakeBlobService();
    const renders: RenderTarget[] = [];
    store.seedContent('content-1', {
      id: 'content-1',
      groupId: 'group-1',
      sortOrder: 0,
      frameName: 'Old',
      imageEtag: 'image-etag',
      imageSize: 15_000,
      audioEtag: null,
      kind: 'image',
    });
    store.seedSource('content-1', {
      contentId: 'content-1',
      status: 'ready',
      sourceEtag,
      mimeType: 'image/png',
      size: source.byteLength,
      storageKey: blobs.sourceKey('group-1', 'content-1'),
    });
    blobs.storage.set(blobs.sourceKey('group-1', 'content-1'), source);
    const service = createContentsService({ store, blobs, renders });

    await service.patchFrameName('content-1', 'user-1', 'Renamed');
    await service.patchImage('content-1', 'user-1', {
      hasImage: false,
      imageBuf: null,
      hasAudio: true,
      audioBuf: Buffer.from('uploaded audio'),
      hasFrameName: false,
      frameName: null,
    });

    expect(renders).toEqual([]);
    expect(blobs.storage.get(blobs.sourceKey('group-1', 'content-1'))).toEqual(source);
    expect(store.source('content-1')).toMatchObject({ sourceEtag, size: source.byteLength });
    expect(store.content('content-1')).toMatchObject({
      frameName: 'Renamed',
      audioEtag: computeETag(Buffer.from('uploaded audio')),
    });
  });

  it('keeps static content usable when only the virtual variant fails', async () => {
    const store = new FakeContentStore();
    const blobs = new FakeBlobService();
    const renders: RenderTarget[] = [];
    const service = createContentsService({
      store,
      blobs,
      renders,
      failProfiles: new Set([VIRTUAL_PROFILE]),
    });

    const response = await service.appendImage('group-1', 'user-1', {
      hasImage: true,
      imageBuf: Buffer.from('source'),
      hasAudio: false,
      audioBuf: null,
      hasFrameName: false,
      frameName: null,
    });

    expect(response.image_etag).toBe(computeETag(Buffer.alloc(15_000, 0x11)));
    expect(store.content(response.id)).toMatchObject({ imageSize: 15_000 });
    expect(blobs.legacy.get(`group-1/${response.id}.image`)).toEqual(Buffer.alloc(15_000, 0x11));
    expect(renders.map((target) => target.profileId)).toEqual([NOTE4_PROFILE, VIRTUAL_PROFILE]);
  });

  it('rolls back a new static upload when the Note4 variant cannot be rendered', async () => {
    const store = new FakeContentStore();
    const blobs = new FakeBlobService();
    const renders: RenderTarget[] = [];
    const service = createContentsService({
      store,
      blobs,
      renders,
      failProfiles: new Set([NOTE4_PROFILE]),
    });

    await expect(
      service.appendImage('group-1', 'user-1', {
        hasImage: true,
        imageBuf: Buffer.from('source'),
        hasAudio: false,
        audioBuf: null,
        hasFrameName: false,
        frameName: null,
      })
    ).rejects.toThrow(/Note4 图片变体渲染失败/);

    expect(store.contentCount()).toBe(0);
    expect(store.sourceCount()).toBe(0);
    expect(blobs.storage.size).toBe(0);
    expect(blobs.legacy.size).toBe(0);
  });

  it('uses only the profiles exposed by the variant renderer', async () => {
    const store = new FakeContentStore();
    const blobs = new FakeBlobService();
    const renders: RenderTarget[] = [];
    const service = createContentsService({ store, blobs, renders, profiles: [NOTE4_PROFILE] });

    await service.appendImage('group-1', 'user-1', {
      hasImage: true,
      imageBuf: Buffer.from('source'),
      hasAudio: false,
      audioBuf: null,
      hasFrameName: false,
      frameName: null,
    });

    expect(renders.map((target) => target.profileId)).toEqual([NOTE4_PROFILE]);
    expect([...blobs.storage.keys()].some((key) => key.includes(VIRTUAL_PROFILE))).toBe(false);
  });
});

function createContentsService(input: {
  store: FakeContentStore;
  blobs: FakeBlobService;
  renders: RenderTarget[];
  failProfiles?: Set<string>;
  profiles?: string[];
}): ContentsService {
  return new ContentsService(
    input.store.prisma as unknown as PrismaService,
    input.blobs as unknown as BlobService,
    {
      assertOwned: async () => undefined,
      recomputeManifestEtag: async () => 'manifest-etag-1',
      recomputeGroupEtags: async () => ({
        structureEtag: 'structure-etag',
        manifestEtag: 'manifest-etag-2',
        contentEtags: [{ id: input.store.onlyContentId(), etag: 'content-etag-2' }],
      }),
    } as unknown as GroupsService,
    {
      renderTo1bpp: async (_source: Buffer, target: RenderTarget) => {
        input.renders.push(target);
        if (input.failProfiles?.has(target.profileId)) {
          throw new Error(`render failed for ${target.profileId}`);
        }
        return {
          data: Buffer.alloc(target.byteLength, target.profileId === NOTE4_PROFILE ? 0x11 : 0x22),
          width: target.width,
          height: target.height,
          fromCache: false,
        };
      },
      validateFrameSize: () => undefined,
    } as unknown as ImageRendererService,
    {
      transcodeAudio: async (audio: Buffer) => Buffer.from(audio),
    } as unknown as AudioTranscoderService,
    {} as unknown as TtsService,
    {
      delete: async () => undefined,
    } as unknown as ContentAudioBlobService,
    {
      renderContentVariants: async ({
        groupId,
        contentId,
        render,
      }: {
        groupId: string;
        contentId: string;
        render: (target: RenderTarget) => Promise<Buffer> | Buffer;
      }) => {
        const results = [];
        for (const profileId of input.profiles ?? [NOTE4_PROFILE, VIRTUAL_PROFILE]) {
          const target = renderTargetForProfile(profileId);
          try {
            const frame = Buffer.from(await render(target));
            const storageKey = input.blobs.frameKey(groupId, contentId, profileId);
            await input.blobs.writeStorageKey(storageKey, 'frame', frame);
            results.push({
              profileId,
              status: 'ready' as const,
              changed: true,
              frameEtag: computeETag(frame),
              frameSize: frame.byteLength,
              storageKey,
              renderVersion: 1,
            });
          } catch (err) {
            results.push({
              profileId,
              status: 'failed' as const,
              changed: true,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return { contentId, renderVersion: 1, results };
      },
    } as unknown as VariantRenderService
  );
}

class FakeContentStore {
  private readonly contents = new Map<string, Record<string, unknown>>();
  private readonly sources = new Map<string, Record<string, unknown>>();

  readonly prisma = {
    content: {
      findUnique: async ({ where }: { where: { id: string } }) => this.contents.get(where.id),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const current = this.content(where.id);
        this.applySourceMutation(where.id, data);
        Object.assign(current, data, { contentEtag: 'content-etag-2' });
        return {
          imageEtag: current.imageEtag,
          audioEtag: current.audioEtag,
          contentEtag: current.contentEtag,
        };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $queryRaw: async () => [{ id: 'group-1' }],
        content: {
          findUnique: async ({ where }: { where: { id: string } }) => this.contents.get(where.id),
          findFirst: async () => null,
          findMany: async () => [],
          create: async ({ data }: { data: Record<string, unknown> }) => {
            this.contents.set(String(data.id), { ...data, contentEtag: 'content-etag-1' });
            if (data.source && typeof data.source === 'object' && 'create' in data.source) {
              this.sources.set(String(data.id), {
                contentId: String(data.id),
                ...(data.source.create as Record<string, unknown>),
              });
            }
            return { contentEtag: 'content-etag-1' };
          },
          update: async ({
            where,
            data,
          }: {
            where: { id: string };
            data: Record<string, unknown>;
          }) => {
            const current = this.content(where.id);
            this.applySourceMutation(where.id, data);
            Object.assign(current, data, { contentEtag: 'content-etag-2' });
            return {
              imageEtag: current.imageEtag,
              audioEtag: current.audioEtag,
              contentEtag: current.contentEtag,
            };
          },
          delete: async ({ where }: { where: { id: string } }) => {
            this.contents.delete(where.id);
            this.sources.delete(where.id);
          },
        },
        contentSource: {
          findUnique: async ({ where }: { where: { contentId: string } }) =>
            this.sources.get(where.contentId) ?? null,
          upsert: async ({
            where,
            create,
            update,
          }: {
            where: { contentId: string };
            create: Record<string, unknown>;
            update: Record<string, unknown>;
          }) => {
            const next = this.sources.has(where.contentId) ? update : create;
            this.sources.set(where.contentId, { contentId: where.contentId, ...next });
            return this.sources.get(where.contentId);
          },
          deleteMany: async ({ where }: { where: { contentId: string } }) => {
            this.sources.delete(where.contentId);
            return { count: 1 };
          },
        },
      }),
    contentSource: {
      findUnique: async ({ where }: { where: { contentId: string } }) =>
        this.sources.get(where.contentId) ?? null,
    },
  };

  content(id: string): Record<string, unknown> {
    const row = this.contents.get(id);
    if (!row) throw new Error(`missing content ${id}`);
    return row;
  }

  source(id: string): Record<string, unknown> {
    const row = this.sources.get(id);
    if (!row) throw new Error(`missing source ${id}`);
    return row;
  }

  onlyContentId(): string {
    const ids = [...this.contents.keys()];
    if (ids.length !== 1) throw new Error(`expected one content row, got ${ids.length}`);
    return ids[0]!;
  }

  seedContent(id: string, row: Record<string, unknown>): void {
    this.contents.set(id, { ...row, contentEtag: 'content-etag-1' });
  }

  seedSource(id: string, row: Record<string, unknown>): void {
    this.sources.set(id, { ...row });
  }

  contentCount(): number {
    return this.contents.size;
  }

  sourceCount(): number {
    return this.sources.size;
  }

  private applySourceMutation(contentId: string, data: Record<string, unknown>): void {
    if (!data.source || typeof data.source !== 'object') return;
    const source = data.source as {
      upsert?: { create: Record<string, unknown>; update: Record<string, unknown> };
    };
    if (source.upsert) {
      this.sources.set(contentId, {
        contentId,
        ...(this.sources.has(contentId) ? source.upsert.update : source.upsert.create),
      });
    }
    delete data.source;
  }
}

class FakeBlobService {
  readonly storage = new Map<string, Buffer>();
  readonly legacy = new Map<string, Buffer>();

  sourceKey(groupId: string, contentId: string): string {
    return `sources/${groupId}/${contentId}.source`;
  }

  frameKey(groupId: string, contentId: string, profileId: string): string {
    return `frames/${profileId}/${groupId}/${contentId}.img`;
  }

  async writeStorageKey(
    key: string,
    _kind: string,
    data: Buffer
  ): Promise<{ path: string; size: number }> {
    this.storage.set(key, Buffer.from(data));
    return { path: key, size: data.byteLength };
  }

  async readStorageKey(key: string): Promise<Buffer | null> {
    const data = this.storage.get(key);
    return data ? Buffer.from(data) : null;
  }

  async deleteStorageKey(key: string): Promise<void> {
    this.storage.delete(key);
  }

  async write(
    groupId: string,
    contentId: string,
    kind: string,
    data: Buffer
  ): Promise<{ path: string; size: number }> {
    this.legacy.set(`${groupId}/${contentId}.${kind}`, Buffer.from(data));
    return { path: `${groupId}/${contentId}.${kind}`, size: data.byteLength };
  }

  async read(groupId: string, contentId: string, kind: string): Promise<Buffer | null> {
    const data = this.legacy.get(`${groupId}/${contentId}.${kind}`);
    return data ? Buffer.from(data) : null;
  }

  async delete(groupId: string, contentId: string, kind: string): Promise<void> {
    this.legacy.delete(`${groupId}/${contentId}.${kind}`);
  }
}
