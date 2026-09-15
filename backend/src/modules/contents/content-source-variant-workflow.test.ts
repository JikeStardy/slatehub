import { describe, expect, it, spyOn } from 'bun:test';
import { Logger } from '@nestjs/common';
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
import { audioBlobContentId } from '../../infra/blob/content-audio-blobs';
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
    expect(blobs.legacy.get(`group-1/${contentId}.img`)).toEqual(note4Frame);
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
    blobs.legacy.set('group-1/content-1.img', Buffer.from('old legacy frame'));
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
    expect(blobs.legacy.get('group-1/content-1.img')).toEqual(note4Frame);
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
    expect(blobs.legacy.get(`group-1/${response.id}.img`)).toEqual(Buffer.alloc(15_000, 0x11));
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

  it('restores a complete replacement snapshot when Note4 becomes unavailable', async () => {
    const { store, blobs } = seedReadyStaticContent();
    const renders: RenderTarget[] = [];
    const service = createContentsService({
      store,
      blobs,
      renders,
      failProfiles: new Set([NOTE4_PROFILE]),
      preservePreviousOnFailure: false,
    });
    const before = snapshotState(store, blobs, 'content-1');

    await expect(
      service.patchImage('content-1', 'user-1', {
        hasImage: true,
        imageBuf: Buffer.from('replacement source bytes'),
        hasAudio: false,
        audioBuf: null,
        hasFrameName: true,
        frameName: 'Replacement',
      })
    ).rejects.toThrow(/Note4 图片变体渲染失败/);

    expect(snapshotState(store, blobs, 'content-1')).toEqual(before);
  });

  it('restores replacement content, source, variants, legacy, and audio when legacy mirror write fails', async () => {
    const { store, blobs } = seedReadyStaticContent();
    const renders: RenderTarget[] = [];
    blobs.failLegacyWrite = true;
    const service = createContentsService({ store, blobs, renders });
    const before = snapshotState(store, blobs, 'content-1');

    await expect(
      service.patchImage('content-1', 'user-1', {
        hasImage: true,
        imageBuf: Buffer.from('replacement source bytes'),
        hasAudio: false,
        audioBuf: null,
        hasFrameName: true,
        frameName: 'Replacement',
      })
    ).rejects.toThrow(/legacy write failed/);

    expect(snapshotState(store, blobs, 'content-1')).toEqual(before);
  });

  it('restores replacement content, source, variants, legacy, and audio when final content update fails', async () => {
    const { store, blobs } = seedReadyStaticContent();
    const renders: RenderTarget[] = [];
    store.failFinalImageUpdate = true;
    const service = createContentsService({ store, blobs, renders });
    const before = snapshotState(store, blobs, 'content-1');

    await expect(
      service.patchImage('content-1', 'user-1', {
        hasImage: true,
        imageBuf: Buffer.from('replacement source bytes'),
        hasAudio: false,
        audioBuf: null,
        hasFrameName: true,
        frameName: 'Replacement',
      })
    ).rejects.toThrow(/final content update failed/);

    expect(snapshotState(store, blobs, 'content-1')).toEqual(before);
  });

  it('keeps created content and blobs recoverable when create compensation DB fails', async () => {
    const store = new FakeContentStore();
    const blobs = new FakeBlobService();
    const renders: RenderTarget[] = [];
    store.failContentDelete = true;
    const service = createContentsService({
      store,
      blobs,
      renders,
      failProfiles: new Set([NOTE4_PROFILE]),
    });

    await expect(
      service.appendImage('group-1', 'user-1', {
        hasImage: true,
        imageBuf: Buffer.from('source bytes'),
        hasAudio: true,
        audioBuf: Buffer.from('audio bytes'),
        hasFrameName: false,
        frameName: null,
      })
    ).rejects.toThrow(/static_create_compensation_failed/);

    const contentId = store.onlyContentId();
    expect(store.source(contentId)).toMatchObject({ status: 'ready' });
    expect(blobs.storage.get(blobs.sourceKey('group-1', contentId))).toEqual(
      Buffer.from('source bytes')
    );
    expect([...blobs.storage.keys()].some((key) => key.includes(VIRTUAL_PROFILE))).toBe(true);
    expect([...blobs.legacy.keys()].some((key) => key.includes(contentId))).toBe(true);
  });

  it('renders every static variant from the exact uploaded source bytes', async () => {
    const original = Buffer.from('exact source consumed by renderer');
    const store = new FakeContentStore();
    const blobs = new FakeBlobService();
    const renderSources: Buffer[] = [];
    const service = createContentsService({ store, blobs, renders: [], renderSources });

    await service.appendImage('group-1', 'user-1', {
      hasImage: true,
      imageBuf: original,
      imageMimeType: 'image/png',
      hasAudio: false,
      audioBuf: null,
      hasFrameName: false,
      frameName: null,
    });

    expect(renderSources).toEqual([original, original]);
  });

  it('serializes replacement workflows per content id', async () => {
    const { store, blobs } = seedReadyStaticContent();
    const firstMayFinish = deferred<void>();
    const firstStarted = deferred<void>();
    const renders: RenderTarget[] = [];
    let note4RenderCalls = 0;
    const service = createContentsService({
      store,
      blobs,
      renders,
      beforeRender: async (target) => {
        if (target.profileId !== NOTE4_PROFILE) return;
        note4RenderCalls += 1;
        if (note4RenderCalls === 1) {
          firstStarted.resolve();
          await firstMayFinish.promise;
        }
      },
    });

    const first = service.patchImage('content-1', 'user-1', {
      hasImage: true,
      imageBuf: Buffer.from('first replacement'),
      hasAudio: false,
      audioBuf: null,
      hasFrameName: true,
      frameName: 'First',
    });
    await firstStarted.promise;
    const second = service.patchImage('content-1', 'user-1', {
      hasImage: true,
      imageBuf: Buffer.from('second replacement'),
      hasAudio: false,
      audioBuf: null,
      hasFrameName: true,
      frameName: 'Second',
    });

    await Promise.resolve();
    expect(note4RenderCalls).toBe(1);
    firstMayFinish.resolve();
    await first;
    await second;

    expect(store.source('content-1').sourceEtag).toBe(
      computeETag(Buffer.from('second replacement'))
    );
    expect(store.content('content-1').frameName).toBe('Second');
  });

  it('queues static name, TTS, audio delete, and delete mutations behind a failing replacement', async () => {
    const cases: Array<{
      name: string;
      start: (service: ContentsService) => Promise<unknown>;
      unchanged: (store: FakeContentStore) => void;
    }> = [
      {
        name: 'frame name',
        start: (service) => service.patchFrameName('content-1', 'user-1', 'Queued name'),
        unchanged: (store) => expect(store.content('content-1').frameName).not.toBe('Queued name'),
      },
      {
        name: 'TTS',
        start: (service) =>
          service.generateImageTts('content-1', 'user-1', {
            text: 'queued speech',
            voice: 'voice-a',
          }),
        unchanged: (store) =>
          expect(store.content('content-1').audioText).not.toBe('queued speech'),
      },
      {
        name: 'audio delete',
        start: (service) => service.deleteAudio('content-1', 'user-1'),
        unchanged: (store) => expect(store.content('content-1').audioStatus).toBe('none'),
      },
      {
        name: 'content delete',
        start: (service) => service.delete('content-1', 'user-1'),
        unchanged: (store) => expect(store.contentCount()).toBe(1),
      },
    ];

    for (const entry of cases) {
      const { store, blobs } = seedReadyStaticContent();
      const renderStarted = deferred<void>();
      const replacementMayFail = deferred<void>();
      const service = createContentsService({
        store,
        blobs,
        renders: [],
        failProfiles: new Set([NOTE4_PROFILE]),
        preservePreviousOnFailure: false,
        beforeRender: async (target) => {
          if (target.profileId !== NOTE4_PROFILE) return;
          renderStarted.resolve();
          await replacementMayFail.promise;
        },
      });

      const replacement = service.patchImage('content-1', 'user-1', {
        hasImage: true,
        imageBuf: Buffer.from(`replacement before queued ${entry.name}`),
        hasAudio: false,
        audioBuf: null,
        hasFrameName: true,
        frameName: 'Replacement',
      });
      await renderStarted.promise;
      const queued = entry.start(service);
      let queuedSettled = false;
      queued.finally(() => {
        queuedSettled = true;
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(queuedSettled).toBe(false);
      entry.unchanged(store);

      replacementMayFail.resolve();
      await expect(replacement).rejects.toThrow(/Note4 图片变体渲染失败/);
      await queued;
    }
  });

  it('cleans every static blob only after the delete transaction commits', async () => {
    const { store, blobs } = seedReadyStaticContent();
    const sourceKey = blobs.sourceKey('group-1', 'content-1');
    const note4Key = blobs.frameKey('group-1', 'content-1', NOTE4_PROFILE);
    const migratedLegacyKey = 'group-1/content-1.img';
    const audioDeletes: Array<{ groupId: string; contentId: string; audioEtag: string | null }> =
      [];
    blobs.storage.set(migratedLegacyKey, Buffer.from('migrated legacy frame'));
    store.seedVariant('content-1', 'legacy-note4', {
      contentId: 'content-1',
      profileId: 'legacy-note4',
      status: 'ready',
      pixelFormat: 'mono',
      frameCodec: 'raw',
      width: 400,
      height: 300,
      frameEtag: 'legacy-etag',
      frameSize: 15_000,
      storageKey: migratedLegacyKey,
      renderVersion: 1,
      lastError: null,
      leaseUntil: null,
      attempts: 0,
    });
    store.seedVariant('content-1', 'duplicate-note4', {
      contentId: 'content-1',
      profileId: 'duplicate-note4',
      status: 'ready',
      pixelFormat: 'mono',
      frameCodec: 'raw',
      width: 400,
      height: 300,
      frameEtag: 'duplicate-etag',
      frameSize: 15_000,
      storageKey: note4Key,
      renderVersion: 1,
      lastError: null,
      leaseUntil: null,
      attempts: 0,
    });
    blobs.failDeleteStorageKeys.add(migratedLegacyKey);
    const warn = spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = createContentsService({
      store,
      blobs,
      renders: [],
      audioDeletes,
      onBlobDelete: (key) => {
        expect(store.inTransaction).toBe(false);
        expect(store.contentCount()).toBe(0);
        blobs.deleteAttempts.push(key);
      },
    });

    try {
      await expect(service.delete('content-1', 'user-1')).resolves.toBeUndefined();

      expect(store.contentCount()).toBe(0);
      expect(store.sourceCount()).toBe(0);
      expect(store.variantsFor('content-1')).toEqual([]);
      expect(blobs.storage.has(sourceKey)).toBe(false);
      expect(blobs.storage.has(note4Key)).toBe(false);
      expect(blobs.storage.has(migratedLegacyKey)).toBe(true);
      expect(blobs.legacy.has('group-1/content-1.img')).toBe(true);
      expect(audioDeletes).toEqual([
        {
          groupId: 'group-1',
          contentId: 'content-1',
          audioEtag: computeETag(Buffer.from('old audio bytes')),
        },
      ]);
      expect(blobs.deleteAttempts).toEqual([
        sourceKey,
        note4Key,
        blobs.frameKey('group-1', 'content-1', VIRTUAL_PROFILE),
        migratedLegacyKey,
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Content content-1 was deleted, but 1 blob cleanup operation(s) failed.'
        )
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('restores missing old source and variant blobs by deleting replacement blobs', async () => {
    const { store, blobs } = seedReadyStaticContent();
    const sourceKey = blobs.sourceKey('group-1', 'content-1');
    const note4Key = blobs.frameKey('group-1', 'content-1', NOTE4_PROFILE);
    const virtualKey = blobs.frameKey('group-1', 'content-1', VIRTUAL_PROFILE);
    blobs.storage.delete(sourceKey);
    blobs.storage.delete(note4Key);
    blobs.storage.delete(virtualKey);
    store.failFinalImageUpdate = true;
    const service = createContentsService({ store, blobs, renders: [] });
    const before = snapshotState(store, blobs, 'content-1');

    await expect(
      service.patchImage('content-1', 'user-1', {
        hasImage: true,
        imageBuf: Buffer.from('replacement source bytes'),
        hasAudio: false,
        audioBuf: null,
        hasFrameName: true,
        frameName: 'Replacement',
      })
    ).rejects.toThrow(/final content update failed/);

    expect(snapshotState(store, blobs, 'content-1')).toEqual(before);
    expect(blobs.storage.has(sourceKey)).toBe(false);
    expect(blobs.storage.has(note4Key)).toBe(false);
    expect(blobs.storage.has(virtualKey)).toBe(false);
  });

  it('rolls replacement compensation forward when an old blob restore fails', async () => {
    const { store, blobs } = seedReadyStaticContent();
    store.failFinalImageUpdate = true;
    const oldSourceKey = blobs.sourceKey('group-1', 'content-1');
    const service = createContentsService({
      store,
      blobs,
      renders: [],
      beforeRender: async (target) => {
        if (target.profileId === NOTE4_PROFILE) blobs.failWritesFor.add(oldSourceKey);
      },
    });

    await expect(
      service.patchImage('content-1', 'user-1', {
        hasImage: true,
        imageBuf: Buffer.from('replacement source bytes'),
        hasAudio: false,
        audioBuf: null,
        hasFrameName: true,
        frameName: 'Replacement',
      })
    ).rejects.toThrow(/static_replace_compensation_failed/);

    expect(store.content('content-1')).toMatchObject({
      frameName: 'Replacement',
      audioEtag: null,
      imageEtag: computeETag(Buffer.alloc(15_000, 0x11)),
      imageSize: 15_000,
    });
    expectCoherentReplacementState(store, blobs, Buffer.from('replacement source bytes'));
    expect(store.source('content-1')).toMatchObject({ storageKey: oldSourceKey });
  });

  it('rolls replacement blobs forward when old DB restore fails after blob restoration', async () => {
    const { store, blobs } = seedReadyStaticContent();
    store.failFinalImageUpdate = true;
    store.failRestoreDb = true;
    const sourceKey = blobs.sourceKey('group-1', 'content-1');
    const service = createContentsService({ store, blobs, renders: [] });

    await expect(
      service.patchImage('content-1', 'user-1', {
        hasImage: true,
        imageBuf: Buffer.from('replacement source bytes'),
        hasAudio: false,
        audioBuf: null,
        hasFrameName: true,
        frameName: 'Replacement',
      })
    ).rejects.toThrow(/static_replace_compensation_failed/);

    expect(store.content('content-1')).toMatchObject({
      frameName: 'Replacement',
      audioEtag: null,
      imageEtag: computeETag(Buffer.alloc(15_000, 0x11)),
      imageSize: 15_000,
    });
    expectCoherentReplacementState(store, blobs, Buffer.from('replacement source bytes'));
    expect(store.source('content-1')).toMatchObject({ storageKey: sourceKey });
  });
});

function createContentsService(input: {
  store: FakeContentStore;
  blobs: FakeBlobService;
  renders: RenderTarget[];
  failProfiles?: Set<string>;
  profiles?: string[];
  preservePreviousOnFailure?: boolean;
  renderSources?: Buffer[];
  beforeRender?: (target: RenderTarget) => Promise<void>;
  audioDeletes?: Array<{ groupId: string; contentId: string; audioEtag: string | null }>;
  onBlobDelete?: (key: string) => void;
}): ContentsService {
  input.blobs.onDelete = input.onBlobDelete;
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
      renderTo1bpp: async (source: Buffer, target: RenderTarget) => {
        input.renderSources?.push(Buffer.from(source));
        input.renders.push(target);
        await input.beforeRender?.(target);
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
    {
      normalizeVoice: (voice: string) => voice,
    } as unknown as TtsService,
    {
      delete: async (groupId: string, contentId: string, audioEtag: string | null) => {
        input.audioDeletes?.push({ groupId, contentId, audioEtag });
      },
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
          const previous = input.store.variant(contentId, profileId);
          try {
            const frame = Buffer.from(await render(target));
            const storageKey = input.blobs.frameKey(groupId, contentId, profileId);
            await input.blobs.writeStorageKey(storageKey, 'frame', frame);
            input.store.upsertVariant(contentId, profileId, {
              contentId,
              profileId,
              status: 'ready',
              pixelFormat: target.pixelFormat,
              frameCodec: target.frameCodec,
              width: target.width,
              height: target.height,
              frameEtag: computeETag(frame),
              frameSize: frame.byteLength,
              storageKey,
              renderVersion: 1,
              lastError: null,
              leaseUntil: null,
              attempts: 0,
            });
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
            const error = err instanceof Error ? err.message : String(err);
            if (
              input.preservePreviousOnFailure !== false &&
              previous?.status === 'ready' &&
              previous.frameEtag &&
              previous.storageKey
            ) {
              input.store.upsertVariant(contentId, profileId, {
                ...previous,
                lastError: error,
                attempts: Number(previous.attempts ?? 0) + 1,
              });
              results.push({
                profileId,
                status: 'ready' as const,
                changed: false,
                frameEtag: previous.frameEtag as string,
                frameSize: previous.frameSize as number,
                storageKey: previous.storageKey as string,
                renderVersion: previous.renderVersion as number,
                error,
              });
              continue;
            }
            input.store.upsertVariant(contentId, profileId, {
              contentId,
              profileId,
              status: 'failed',
              pixelFormat: target.pixelFormat,
              frameCodec: target.frameCodec,
              width: target.width,
              height: target.height,
              frameEtag: null,
              frameSize: null,
              storageKey: null,
              renderVersion: 1,
              lastError: error,
              leaseUntil: null,
              attempts: Number(previous?.attempts ?? 0) + 1,
            });
            results.push({
              profileId,
              status: 'failed' as const,
              changed: true,
              error,
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
  private readonly variants = new Map<string, Record<string, unknown>>();
  failFinalImageUpdate = false;
  failContentDelete = false;
  failRestoreDb = false;
  inTransaction = false;

  readonly prisma = {
    content: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        cloneRow(this.contents.get(where.id)),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        if (this.shouldFailFinalImageUpdate(data)) throw new Error('final content update failed');
        const current = this.content(where.id);
        this.applySourceMutation(where.id, data);
        Object.assign(current, data);
        if (data.contentEtag === undefined) current.contentEtag = 'content-etag-2';
        return {
          imageEtag: current.imageEtag,
          audioEtag: current.audioEtag,
          contentEtag: current.contentEtag,
        };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      this.runTransaction(() =>
        fn({
          $queryRaw: async () => [{ id: 'group-1' }],
          content: {
            findUnique: async ({ where }: { where: { id: string } }) =>
              cloneRow(this.contents.get(where.id)),
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
              if (this.shouldFailFinalImageUpdate(data))
                throw new Error('final content update failed');
              if (this.shouldFailRestoreDb(data)) throw new Error('restore database unavailable');
              const current = this.content(where.id);
              this.applySourceMutation(where.id, data);
              Object.assign(current, data);
              if (data.contentEtag === undefined) current.contentEtag = 'content-etag-2';
              return {
                imageEtag: current.imageEtag,
                audioEtag: current.audioEtag,
                contentEtag: current.contentEtag,
              };
            },
            delete: async ({ where }: { where: { id: string } }) => {
              if (this.failContentDelete) throw new Error('content compensation delete failed');
              this.contents.delete(where.id);
              this.sources.delete(where.id);
              for (const key of [...this.variants.keys()]) {
                if (key.startsWith(`${where.id}:`)) this.variants.delete(key);
              }
            },
          },
          contentSource: {
            findUnique: async ({ where }: { where: { contentId: string } }) =>
              cloneRow(this.sources.get(where.contentId)),
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
          contentVariant: this.contentVariantApi(),
        })
      ),
    contentSource: {
      findUnique: async ({ where }: { where: { contentId: string } }) =>
        cloneRow(this.sources.get(where.contentId)),
    },
    contentVariant: this.contentVariantApi(),
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

  seedVariant(contentId: string, profileId: string, row: Record<string, unknown>): void {
    this.upsertVariant(contentId, profileId, row);
  }

  variant(contentId: string, profileId: string): Record<string, unknown> | null {
    return cloneRow(this.variants.get(`${contentId}:${profileId}`));
  }

  upsertVariant(contentId: string, profileId: string, row: Record<string, unknown>): void {
    this.variants.set(`${contentId}:${profileId}`, { id: `${contentId}-${profileId}`, ...row });
  }

  variantsFor(contentId: string): Record<string, unknown>[] {
    return [...this.variants.entries()]
      .filter(([key]) => key.startsWith(`${contentId}:`))
      .map(([, row]) => cloneRow(row)!);
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

  private shouldFailFinalImageUpdate(data: Record<string, unknown>): boolean {
    const shouldFail =
      this.failFinalImageUpdate &&
      data.imageEtag !== undefined &&
      data.imageSize !== undefined &&
      data.source === undefined;
    if (shouldFail) this.failFinalImageUpdate = false;
    return shouldFail;
  }

  private shouldFailRestoreDb(data: Record<string, unknown>): boolean {
    const shouldFail =
      this.failRestoreDb &&
      data.frameName === 'Old' &&
      data.imageEtag !== undefined &&
      data.source === undefined;
    if (shouldFail) this.failRestoreDb = false;
    return shouldFail;
  }

  private async runTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const contents = cloneTable(this.contents);
    const sources = cloneTable(this.sources);
    const variants = cloneTable(this.variants);
    this.inTransaction = true;
    try {
      return await fn();
    } catch (err) {
      this.contents.clear();
      for (const entry of contents) this.contents.set(entry[0], entry[1]);
      this.sources.clear();
      for (const entry of sources) this.sources.set(entry[0], entry[1]);
      this.variants.clear();
      for (const entry of variants) this.variants.set(entry[0], entry[1]);
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  private contentVariantApi(): Record<string, unknown> {
    return {
      findMany: async ({ where }: { where: { contentId: string } }) =>
        this.variantsFor(where.contentId),
      deleteMany: async ({ where }: { where: { contentId: string } }) => {
        let count = 0;
        for (const key of [...this.variants.keys()]) {
          if (key.startsWith(`${where.contentId}:`)) {
            this.variants.delete(key);
            count += 1;
          }
        }
        return { count };
      },
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        for (const row of data) {
          this.upsertVariant(String(row.contentId), String(row.profileId), row);
        }
        return { count: data.length };
      },
    };
  }
}

class FakeBlobService {
  readonly storage = new Map<string, Buffer>();
  readonly legacy = new Map<string, Buffer>();
  failLegacyWrite = false;
  readonly failWritesFor = new Set<string>();
  readonly failDeleteStorageKeys = new Set<string>();
  readonly deleteAttempts: string[] = [];
  onDelete: ((key: string) => void) | undefined;

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
    if (this.failWritesFor.has(key)) {
      this.failWritesFor.delete(key);
      throw new Error(`storage write failed for ${key}`);
    }
    this.storage.set(key, Buffer.from(data));
    return { path: key, size: data.byteLength };
  }

  async readStorageKey(key: string): Promise<Buffer | null> {
    const data = this.storage.get(key);
    return data ? Buffer.from(data) : null;
  }

  async deleteStorageKey(key: string): Promise<void> {
    this.onDelete?.(key);
    if (this.failDeleteStorageKeys.has(key)) {
      throw new Error(`storage delete failed for ${key}`);
    }
    this.storage.delete(key);
  }

  async write(
    groupId: string,
    contentId: string,
    kind: string,
    data: Buffer
  ): Promise<{ path: string; size: number }> {
    const key = this.blobKey(groupId, contentId, kind);
    if (this.failWritesFor.has(key)) {
      this.failWritesFor.delete(key);
      throw new Error(`legacy write failed for ${key}`);
    }
    if (this.failLegacyWrite && kind === 'image') {
      this.failLegacyWrite = false;
      this.legacy.set(key, Buffer.from(data));
      throw new Error('legacy write failed');
    }
    this.legacy.set(key, Buffer.from(data));
    return { path: key, size: data.byteLength };
  }

  async read(groupId: string, contentId: string, kind: string): Promise<Buffer | null> {
    const data = this.legacy.get(this.blobKey(groupId, contentId, kind));
    return data ? Buffer.from(data) : null;
  }

  async delete(groupId: string, contentId: string, kind: string): Promise<void> {
    const key = this.blobKey(groupId, contentId, kind);
    this.onDelete?.(key);
    this.legacy.delete(key);
  }

  private blobKey(groupId: string, contentId: string, kind: string): string {
    return `${groupId}/${contentId}.${kind === 'image' ? 'img' : 'pcm'}`;
  }
}

function seedReadyStaticContent(): { store: FakeContentStore; blobs: FakeBlobService } {
  const store = new FakeContentStore();
  const blobs = new FakeBlobService();
  const source = Buffer.from('old exact source bytes');
  const note4 = Buffer.alloc(15_000, 0x44);
  const virtual = Buffer.alloc(4_736, 0x55);
  const audio = Buffer.from('old audio bytes');
  const sourceKey = blobs.sourceKey('group-1', 'content-1');
  const note4Key = blobs.frameKey('group-1', 'content-1', NOTE4_PROFILE);
  const virtualKey = blobs.frameKey('group-1', 'content-1', VIRTUAL_PROFILE);
  const audioEtag = computeETag(audio);
  store.seedContent('content-1', {
    id: 'content-1',
    groupId: 'group-1',
    sortOrder: 0,
    frameName: 'Old',
    imageEtag: computeETag(note4),
    imageSize: note4.byteLength,
    audioEtag,
    audioSize: audio.byteLength,
    audioStatus: 'ready',
    audioSource: 'upload',
    audioVoice: null,
    audioText: null,
    audioLastError: null,
    audioUpdatedAt: new Date('2026-01-01T00:00:00.000Z'),
    audioLeaseUntil: null,
    audioAttempts: 0,
    kind: 'image',
  });
  store.seedSource('content-1', {
    contentId: 'content-1',
    status: 'ready',
    sourceEtag: computeETag(source),
    mimeType: 'image/png',
    size: source.byteLength,
    storageKey: sourceKey,
  });
  store.seedVariant('content-1', NOTE4_PROFILE, readyVariantRow(NOTE4_PROFILE, note4Key, note4));
  store.seedVariant(
    'content-1',
    VIRTUAL_PROFILE,
    readyVariantRow(VIRTUAL_PROFILE, virtualKey, virtual)
  );
  blobs.storage.set(sourceKey, source);
  blobs.storage.set(note4Key, note4);
  blobs.storage.set(virtualKey, virtual);
  blobs.legacy.set('group-1/content-1.img', note4);
  blobs.legacy.set(`group-1/${audioBlobContentId('content-1', audioEtag)}.pcm`, audio);
  return { store, blobs };
}

function readyVariantRow(
  profileId: string,
  storageKey: string,
  frame: Buffer
): Record<string, unknown> {
  const target = renderTargetForProfile(profileId);
  return {
    contentId: 'content-1',
    profileId,
    status: 'ready',
    pixelFormat: target.pixelFormat,
    frameCodec: target.frameCodec,
    width: target.width,
    height: target.height,
    frameEtag: computeETag(frame),
    frameSize: frame.byteLength,
    storageKey,
    renderVersion: 1,
    lastError: null,
    leaseUntil: null,
    attempts: 0,
  };
}

function snapshotState(
  store: FakeContentStore,
  blobs: FakeBlobService,
  contentId: string
): Record<string, unknown> {
  return {
    content: cloneRow(store.content(contentId)),
    source: cloneRow(store.source(contentId)),
    variants: store.variantsFor(contentId),
    storage: sortedBufferEntries(blobs.storage),
    legacy: sortedBufferEntries(blobs.legacy),
  };
}

function expectCoherentReplacementState(
  store: FakeContentStore,
  blobs: FakeBlobService,
  source: Buffer
): void {
  const note4 = Buffer.alloc(15_000, 0x11);
  const virtual = Buffer.alloc(4_736, 0x22);
  const sourceKey = blobs.sourceKey('group-1', 'content-1');
  const note4Key = blobs.frameKey('group-1', 'content-1', NOTE4_PROFILE);
  const virtualKey = blobs.frameKey('group-1', 'content-1', VIRTUAL_PROFILE);

  expect(store.source('content-1')).toMatchObject({
    status: 'ready',
    sourceEtag: computeETag(source),
    size: source.byteLength,
    storageKey: sourceKey,
  });
  expect(blobs.storage.get(sourceKey)).toEqual(source);

  expect(store.variant('content-1', NOTE4_PROFILE)).toMatchObject({
    status: 'ready',
    frameEtag: computeETag(note4),
    frameSize: note4.byteLength,
    storageKey: note4Key,
  });
  expect(blobs.storage.get(note4Key)).toEqual(note4);

  expect(store.variant('content-1', VIRTUAL_PROFILE)).toMatchObject({
    status: 'ready',
    frameEtag: computeETag(virtual),
    frameSize: virtual.byteLength,
    storageKey: virtualKey,
  });
  expect(blobs.storage.get(virtualKey)).toEqual(virtual);

  expect(blobs.legacy.get('group-1/content-1.img')).toEqual(note4);
}

function sortedBufferEntries(map: Map<string, Buffer>): Array<[string, Buffer]> {
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function cloneRow(row: Record<string, unknown> | undefined): Record<string, unknown> | null {
  return row ? { ...row } : null;
}

function cloneTable(
  map: Map<string, Record<string, unknown>>
): Map<string, Record<string, unknown>> {
  return new Map([...map.entries()].map(([key, row]) => [key, { ...row }]));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
