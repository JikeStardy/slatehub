import { createId } from '@paralleldrive/cuid2';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  ContentAudioSource,
  ContentKind,
  ContentSource,
  ContentVariant,
} from '@prisma/client';
import { type ContentMutationResponseT } from 'shared';
import { BlobService } from '../../infra/blob/blob.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { computeETag } from '../../common/utils/etag';
import { ConflictError, InternalError, NotFoundError, ValidationError } from '../../common/errors';
import { lockGroupRow } from '../../common/db/row-locks';
import { bulkSetContentSortOrder, compactContentSortOrders } from '../../common/db/bulk-sort-order';
import { validateOrderSet } from '../../common/db/order-validation';
import { nextContentSortOrder } from '../../common/db/sort-order';
import { formatError } from '../../common/utils/error-format';
import { KeyedPromiseQueue } from '../../common/worker/keyed-promise-queue';
import { AudioTranscoderService } from '../audio/audio-transcoder.service';
import { audioBlobContentId } from '../../infra/blob/content-audio-blobs';
import { MAX_TTS_TEXT_CHARS, TtsService } from '../tts/tts.service';
import { GroupsService } from '../groups/groups.service';
import { ImageRendererService } from '../image-renderer/image-renderer.service';
import { NOTE4_RENDER_TARGET, type RenderTarget } from '../rendering/render-target';
import {
  type VariantRenderResult,
  VariantRenderService,
} from '../rendering/variant-render.service';
import { ContentAudioBlobService } from './content-audio-blob.service';
import { BlobRollbackPlan } from './blob-rollback';
import {
  pendingTtsAudioFields,
  readyUploadedAudioFields,
  resetAudioFields,
} from './content-audio-fields';
import { toContentMutationResponse } from './content-mutation-response';
import type { ParsedContentUpload } from './multipart-parser';

interface RenderedImageUpload {
  bytes: Buffer;
  etag: string;
  size: number;
  mimeType: string;
  storageKey?: string;
}

interface RenderedAudioUpload {
  bytes: Buffer;
  etag: string;
  size: number;
}

interface RenderedUpload {
  image: RenderedImageUpload | null;
  audio: RenderedAudioUpload | null;
}

interface StaticContentSnapshot {
  content: StaticContentRestoreData;
  source: ContentSource | null;
  sourceBytes: Buffer | null;
  variants: ContentVariant[];
  variantBytes: Map<string, Buffer | null>;
  legacyImageBytes: Buffer | null;
  audioBlobKey: string | null;
  audioBytes: Buffer | null;
}

type StaticContentRestoreData = Pick<
  Prisma.ContentUpdateInput,
  | 'frameName'
  | 'imageEtag'
  | 'imageSize'
  | 'audioEtag'
  | 'audioSize'
  | 'audioStatus'
  | 'audioSource'
  | 'audioVoice'
  | 'audioText'
  | 'audioLastError'
  | 'audioUpdatedAt'
  | 'audioLeaseUntil'
  | 'audioAttempts'
>;

@Injectable()
export class ContentsService {
  private readonly logger = new Logger(ContentsService.name);
  private readonly staticMutationQueue = new KeyedPromiseQueue();

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly groups: GroupsService,
    private readonly imageRenderer: ImageRendererService,
    private readonly audio: AudioTranscoderService,
    private readonly tts: TtsService,
    private readonly audioBlobs: ContentAudioBlobService,
    private readonly variantRenderer: VariantRenderService
  ) {}

  async appendImage(
    gid: string,
    ownerUserId: string,
    parsed: ParsedContentUpload,
    signal?: AbortSignal
  ): Promise<ContentMutationResponseT> {
    await this.groups.assertOwned(gid, ownerUserId);
    if (!parsed.hasImage) throw new ValidationError('请上传图片', { code: 'image_required' });
    return this.createImage(gid, parsed, signal);
  }

  async patchImage(
    contentId: string,
    ownerUserId: string,
    parsed: ParsedContentUpload,
    signal?: AbortSignal
  ): Promise<ContentMutationResponseT> {
    return this.staticMutationQueue.run(
      contentId,
      () => this.patchImageUnqueued(contentId, ownerUserId, parsed, signal),
      { continueAfterFailure: true }
    );
  }

  async patchFrameName(
    contentId: string,
    ownerUserId: string,
    frameName: string | null | undefined
  ): Promise<ContentMutationResponseT> {
    return this.staticMutationQueue.run(
      contentId,
      () => this.patchFrameNameUnqueued(contentId, ownerUserId, frameName),
      { continueAfterFailure: true }
    );
  }

  async delete(contentId: string, ownerUserId: string): Promise<void> {
    return this.staticMutationQueue.run(
      contentId,
      () => this.deleteUnqueued(contentId, ownerUserId),
      { continueAfterFailure: true }
    );
  }

  async deleteAudio(contentId: string, ownerUserId: string): Promise<{ manifest_etag: string }> {
    return this.staticMutationQueue.run(
      contentId,
      () => this.deleteAudioUnqueued(contentId, ownerUserId),
      { continueAfterFailure: true }
    );
  }

  async generateImageTts(
    contentId: string,
    ownerUserId: string,
    raw: { text: string; voice: string }
  ): Promise<ContentMutationResponseT> {
    return this.staticMutationQueue.run(
      contentId,
      () => this.generateImageTtsUnqueued(contentId, ownerUserId, raw),
      { continueAfterFailure: true }
    );
  }

  private async patchImageUnqueued(
    contentId: string,
    ownerUserId: string,
    parsed: ParsedContentUpload,
    signal?: AbortSignal
  ): Promise<ContentMutationResponseT> {
    const content = await this.requireOwnedContent(contentId, ownerUserId);
    if (content.kind !== 'image') {
      throw new ValidationError('动态内容请使用 JSON 更新');
    }
    return this.updateImage(
      content.groupId,
      content.sortOrder,
      contentId,
      parsed,
      content.audioEtag,
      signal
    );
  }

  private async patchFrameNameUnqueued(
    contentId: string,
    ownerUserId: string,
    frameName: string | null | undefined
  ): Promise<ContentMutationResponseT> {
    const content = await this.requireOwnedContent(contentId, ownerUserId);
    if (frameName === undefined) {
      throw new ValidationError('没有可更新的字段', { code: 'nothing_to_patch' });
    }
    if (content.kind === 'dynamic') {
      throw new ValidationError('动态内容请使用动态内容服务更新');
    }
    const { updated, groupEtag } = await this.withGroupMutation(content.groupId, async (tx) => {
      const updated = await tx.content.update({
        where: { id: contentId },
        data: { frameName },
        select: { contentEtag: true },
      });
      return { updated };
    });
    return toContentMutationResponse(
      contentId,
      content.sortOrder,
      content.imageEtag,
      content.audioEtag,
      groupEtag,
      updated.contentEtag
    );
  }

  private async deleteUnqueued(contentId: string, ownerUserId: string): Promise<void> {
    const content = await this.requireOwnedContent(contentId, ownerUserId);
    await this.withGroupMutation(content.groupId, async (tx) => {
      await tx.content.delete({ where: { id: contentId } });
      await compactContentSortOrders(tx, content.groupId);
      return {};
    });
    const deleted = await Promise.allSettled([
      this.blob.delete(content.groupId, contentId, 'image'),
      this.audioBlobs.delete(content.groupId, contentId, content.audioEtag),
    ]);
    const failed = deleted.filter((result) => result.status === 'rejected').length;
    if (failed > 0) {
      this.logger.warn(
        `Content ${contentId} was deleted, but ${failed} blob cleanup operation(s) failed.`
      );
    }
  }

  private async deleteAudioUnqueued(
    contentId: string,
    ownerUserId: string
  ): Promise<{ manifest_etag: string }> {
    const content = await this.requireOwnedContent(contentId, ownerUserId);
    const previousAudioEtag = content.audioEtag;
    const { groupEtag } = await this.withGroupMutation(content.groupId, async (tx) => {
      await tx.content.update({
        where: { id: contentId },
        data: resetAudioFields(),
      });
      return {};
    });
    await this.cleanupAudioBlobAfterCommit(content.groupId, contentId, previousAudioEtag);
    return { manifest_etag: groupEtag };
  }

  private async generateImageTtsUnqueued(
    contentId: string,
    ownerUserId: string,
    raw: { text: string; voice: string }
  ): Promise<ContentMutationResponseT> {
    const content = await this.requireOwnedContent(contentId, ownerUserId);
    if (content.kind !== 'image') throw new ValidationError('只有图片内容支持手动输入 TTS 文案');
    const text = raw.text.trim();
    if (!text) throw new ValidationError('TTS 文案不能为空');
    if (text.length > MAX_TTS_TEXT_CHARS) {
      throw new ValidationError(`TTS 文案不能超过 ${MAX_TTS_TEXT_CHARS} 字`, {
        code: 'tts_text_too_long',
        max_chars: MAX_TTS_TEXT_CHARS,
      });
    }
    const voice = this.tts.normalizeVoice(raw.voice);

    const previousAudioEtag = content.audioEtag;
    const { updated, groupEtag } = await this.withGroupMutation(content.groupId, async (tx) => {
      const updated = await tx.content.update({
        where: { id: contentId },
        data: pendingTtsAudioFields(text, voice),
        select: { contentEtag: true },
      });
      return { updated };
    });
    await this.cleanupAudioBlobAfterCommit(content.groupId, contentId, previousAudioEtag);
    return toContentMutationResponse(
      contentId,
      content.sortOrder,
      content.imageEtag,
      null,
      groupEtag,
      updated.contentEtag
    );
  }

  async reorder(
    gid: string,
    ownerUserId: string,
    order: string[]
  ): Promise<{ manifest_etag: string }> {
    await this.groups.assertOwned(gid, ownerUserId);
    const { groupEtag } = await this.withGroupMutation(gid, async (tx) => {
      const all = await tx.content.findMany({
        where: { groupId: gid },
        select: { id: true },
      });
      validateOrderSet(
        all.map((content) => content.id),
        order,
        {
          mismatchMessage: '排序列表须覆盖该组的所有内容且不重复',
          mismatchCode: 'order_mismatch',
        }
      );
      await bulkSetContentSortOrder(tx, gid, order);
      return {};
    });
    return { manifest_etag: groupEtag };
  }

  private async createImage(
    gid: string,
    parsed: ParsedContentUpload,
    signal?: AbortSignal
  ): Promise<ContentMutationResponseT> {
    const { image, audio } = await this.renderUpload(parsed, signal);
    if (!image) throw new ValidationError('创建图片内容时必须上传图片');
    const contentId = createId();
    const rollback = new BlobRollbackPlan(this.blob, this.logger);
    const sourceKey = this.blob.sourceKey(gid, contentId);
    image.storageKey = sourceKey;
    let dbCreated = false;
    let mutation: { seq: number; groupEtag: string; contentEtag: string };
    let finalImageEtag: string;
    let variantResults: VariantRenderResult[] = [];
    try {
      await this.blob.writeStorageKey(sourceKey, 'source', image.bytes);
      rollback.deleteCreated(gid, contentId, 'image');
      if (audio) {
        rollback.deleteCreated(gid, audioBlobContentId(contentId, audio.etag), 'audio');
        await this.blob.write(gid, audioBlobContentId(contentId, audio.etag), 'audio', audio.bytes);
      }
      mutation = await this.withGroupMutation(gid, async (tx) => {
        const nextSeq = await nextContentSortOrder(tx, gid);
        const created = await tx.content.create({
          data: {
            id: contentId,
            groupId: gid,
            sortOrder: nextSeq,
            frameName: parsed.hasFrameName ? parsed.frameName : null,
            imageEtag: image.etag,
            imageSize: image.size,
            ...(audio ? readyUploadedAudioFields(audio.etag, audio.size) : resetAudioFields()),
            kind: 'image',
            source: {
              create: readySourceData(image),
            },
          },
          select: { contentEtag: true },
        });
        return { seq: nextSeq, contentEtag: created.contentEtag };
      });
      dbCreated = true;
      variantResults = await this.renderStaticVariants(gid, contentId, image, parsed);
      const note4 = this.requireReadyNote4(variantResults);
      const legacy = await this.mirrorNote4ToLegacy(gid, contentId, note4, rollback);
      finalImageEtag = legacy.etag;
      mutation = await this.withGroupMutation(gid, async (tx) => {
        const updated = await tx.content.update({
          where: { id: contentId },
          data: { imageEtag: legacy.etag, imageSize: legacy.size },
          select: { contentEtag: true },
        });
        return { seq: mutation.seq, contentEtag: updated.contentEtag };
      });
    } catch (err) {
      if (dbCreated) {
        await this.compensateCreatedContentOrThrow(gid, contentId, err);
        await this.cleanupChangedVariantFrames(variantResults);
        await this.deleteSourceBlobAfterCompensation(gid, contentId, sourceKey);
        await rollback.restoreAll();
      } else {
        await this.deleteSourceBlobAfterCompensation(gid, contentId, sourceKey);
        await rollback.restoreAll();
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw new ConflictError('内容序号已存在');
      throw err;
    }
    return toContentMutationResponse(
      contentId,
      mutation.seq,
      finalImageEtag,
      audio?.etag ?? null,
      mutation.groupEtag,
      mutation.contentEtag
    );
  }

  private async updateImage(
    gid: string,
    seq: number,
    contentId: string,
    parsed: ParsedContentUpload,
    previousAudioEtag: string | null,
    signal?: AbortSignal
  ): Promise<ContentMutationResponseT> {
    const baseData: Prisma.ContentUpdateInput = {};
    if (parsed.hasFrameName) baseData.frameName = parsed.frameName;
    if (parsed.hasFrameName === false && !parsed.hasImage && !parsed.hasAudio) {
      throw new ValidationError('没有可更新的字段', { code: 'nothing_to_patch' });
    }
    const { image, audio } = await this.renderUpload(parsed, signal);
    const snapshot = image ? await this.snapshotStaticContent(gid, contentId) : null;
    const previousSource = image
      ? await this.prisma.contentSource.findUnique({ where: { contentId } })
      : null;
    const sourceKey = image ? this.blob.sourceKey(gid, contentId) : null;
    const previousSourceBytes =
      previousSource?.storageKey && image
        ? await this.blob.readStorageKey(previousSource.storageKey)
        : null;
    if (image && sourceKey) {
      image.storageKey = sourceKey;
      await this.blob.writeStorageKey(sourceKey, 'source', image.bytes);
    }

    const rollback = new BlobRollbackPlan(this.blob, this.logger);
    let dbUpdated = false;
    let previousAudioEtagForCleanup: string | null = null;
    let variantResults: VariantRenderResult[] = [];
    try {
      const { updated, groupEtag } = await this.withGroupMutation(gid, async (tx) => {
        const current = await tx.content.findUnique({
          where: { id: contentId },
          select: { kind: true, groupId: true, audioEtag: true },
        });
        if (!current || current.groupId !== gid) throw new NotFoundError('内容不存在');
        if (current.kind !== 'image') throw new ValidationError('动态内容请使用 JSON 更新');

        const prepared = await this.prepareImageUpdate({
          gid,
          contentId,
          baseData,
          currentAudioEtag: current.audioEtag,
          upload: { image, audio },
          rollback,
        });
        const updated = await tx.content.update({
          where: { id: contentId },
          data: prepared.data,
          select: { imageEtag: true, audioEtag: true, contentEtag: true },
        });
        previousAudioEtagForCleanup = prepared.previousAudioEtagForCleanup;
        return { updated };
      });
      dbUpdated = true;
      if (image) {
        let forwardSnapshot: StaticContentSnapshot | null = null;
        try {
          variantResults = await this.renderStaticVariants(gid, contentId, image, parsed);
          const note4 = this.requireReadyNote4(variantResults);
          forwardSnapshot = await this.buildStaticReplacementForwardSnapshot({
            gid,
            contentId,
            image,
            note4,
          });
          const legacy = await this.mirrorNote4ToLegacy(gid, contentId, note4, rollback);
          const remirrored = await this.withGroupMutation(gid, async (tx) => {
            const updated = await tx.content.update({
              where: { id: contentId },
              data: { imageEtag: legacy.etag, imageSize: legacy.size },
              select: { imageEtag: true, audioEtag: true, contentEtag: true },
            });
            return { updated };
          });
          await this.cleanupAudioBlobAfterCommit(gid, contentId, previousAudioEtagForCleanup);
          return toContentMutationResponse(
            contentId,
            seq,
            remirrored.updated.imageEtag,
            remirrored.updated.audioEtag,
            remirrored.groupEtag,
            remirrored.updated.contentEtag
          );
        } catch (err) {
          if (!snapshot) throw err;
          await this.restoreStaticReplacementOrThrow({
            gid,
            contentId,
            snapshot,
            sourceKey: sourceKey ?? this.blob.sourceKey(gid, contentId),
            newAudioEtag: audio?.etag ?? null,
            variantResults,
            forwardSnapshot,
            originalErr: err,
          });
          throw err;
        }
      }
      await this.cleanupAudioBlobAfterCommit(gid, contentId, previousAudioEtagForCleanup);
      return toContentMutationResponse(
        contentId,
        seq,
        updated.imageEtag,
        updated.audioEtag,
        groupEtag,
        updated.contentEtag
      );
    } catch (err) {
      if (!dbUpdated) {
        if (image && sourceKey) await this.restoreStorageKey(sourceKey, previousSourceBytes);
        await rollback.restoreAll();
      }
      throw err;
    }
  }

  private async prepareImageUpdate(input: {
    gid: string;
    contentId: string;
    baseData: Prisma.ContentUpdateInput;
    currentAudioEtag: string | null;
    upload: RenderedUpload;
    rollback: BlobRollbackPlan;
  }): Promise<{
    data: Prisma.ContentUpdateInput;
    previousAudioEtagForCleanup: string | null;
  }> {
    const { gid, contentId, currentAudioEtag, upload, rollback } = input;
    const data: Prisma.ContentUpdateInput = { ...input.baseData };
    if (upload.image) {
      data.source = {
        upsert: {
          create: readySourceData(upload.image),
          update: readySourceData(upload.image),
        },
      };
      if (!upload.audio && currentAudioEtag) {
        Object.assign(data, resetAudioFields());
      }
    }
    if (upload.audio) {
      if (upload.audio.etag !== currentAudioEtag) {
        rollback.deleteCreated(gid, audioBlobContentId(contentId, upload.audio.etag), 'audio');
      }
      await this.blob.write(
        gid,
        audioBlobContentId(contentId, upload.audio.etag),
        'audio',
        upload.audio.bytes
      );
      Object.assign(data, readyUploadedAudioFields(upload.audio.etag, upload.audio.size));
    }
    const nextAudioEtag =
      upload.audio?.etag ?? (upload.image && currentAudioEtag ? null : currentAudioEtag);
    return {
      data,
      previousAudioEtagForCleanup:
        currentAudioEtag && currentAudioEtag !== nextAudioEtag ? currentAudioEtag : null,
    };
  }

  private async renderUpload(
    parsed: ParsedContentUpload,
    signal?: AbortSignal
  ): Promise<RenderedUpload> {
    let image: RenderedImageUpload | null = null;
    if (parsed.hasImage && parsed.imageBuf) {
      image = {
        bytes: Buffer.from(parsed.imageBuf),
        etag: computeETag(parsed.imageBuf),
        size: parsed.imageBuf.byteLength,
        mimeType: parsed.imageMimeType ?? 'application/octet-stream',
      };
    }

    let audio: RenderedAudioUpload | null = null;
    if (parsed.hasAudio && parsed.audioBuf) {
      const bytes = await this.audio.transcodeAudio(parsed.audioBuf, { signal });
      audio = { bytes, etag: computeETag(bytes), size: bytes.byteLength };
    }
    return { image, audio };
  }

  private async renderStaticVariants(
    gid: string,
    contentId: string,
    image: RenderedImageUpload,
    parsed: ParsedContentUpload
  ): Promise<VariantRenderResult[]> {
    const result = await this.variantRenderer.renderContentVariants({
      groupId: gid,
      contentId,
      render: (target) => this.renderStaticFrame(image, target, parsed),
    });
    return result.results;
  }

  private requireReadyNote4(results: VariantRenderResult[]): VariantRenderResult {
    const note4 = results.find((variant) => variant.profileId === NOTE4_RENDER_TARGET.profileId);
    if (
      note4?.status === 'ready' &&
      note4.storageKey &&
      note4.frameEtag &&
      note4.frameSize !== undefined
    ) {
      return note4;
    }
    throw new ValidationError('Note4 图片变体渲染失败，内容未保存', {
      code: 'note4_variant_required',
      error: note4?.error,
    });
  }

  private async renderStaticFrame(
    image: RenderedImageUpload,
    target: RenderTarget,
    parsed: ParsedContentUpload
  ): Promise<Buffer> {
    const rendered = await this.imageRenderer.renderTo1bpp(image.bytes, target, {
      threshold: parsed.threshold,
      mode: parsed.mode,
      sourceEtag: image.etag,
    });
    this.imageRenderer.validateFrameSize(rendered.data, target);
    return rendered.data;
  }

  private async mirrorNote4ToLegacy(
    gid: string,
    contentId: string,
    note4: VariantRenderResult,
    rollback: BlobRollbackPlan
  ): Promise<{ etag: string; size: number }> {
    if (!note4.storageKey) {
      throw new ValidationError('Note4 图片变体缺少存储位置', {
        code: 'note4_variant_missing_blob',
      });
    }
    const frame = await this.blob.readStorageKey(note4.storageKey);
    if (!frame) {
      throw new ValidationError('Note4 图片变体文件不存在', { code: 'note4_variant_missing_blob' });
    }
    const previousImageBytes = await this.blob.read(gid, contentId, 'image');
    rollback.restorePrevious(gid, contentId, 'image', previousImageBytes);
    await this.blob.write(gid, contentId, 'image', frame);
    return {
      etag: note4.frameEtag ?? computeETag(frame),
      size: note4.frameSize ?? frame.byteLength,
    };
  }

  private async snapshotStaticContent(
    gid: string,
    contentId: string
  ): Promise<StaticContentSnapshot> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: {
        frameName: true,
        imageEtag: true,
        imageSize: true,
        audioEtag: true,
        audioSize: true,
        audioStatus: true,
        audioSource: true,
        audioVoice: true,
        audioText: true,
        audioLastError: true,
        audioUpdatedAt: true,
        audioLeaseUntil: true,
        audioAttempts: true,
      },
    });
    if (!content) throw new NotFoundError('内容不存在');
    const source = await this.prisma.contentSource.findUnique({ where: { contentId } });
    const sourceBytes = source?.storageKey
      ? await this.blob.readStorageKey(source.storageKey)
      : null;
    const variants = await this.prisma.contentVariant.findMany({ where: { contentId } });
    const variantBytes = new Map<string, Buffer | null>();
    await Promise.all(
      variants.map(async (variant) => {
        if (variant.storageKey) {
          variantBytes.set(variant.storageKey, await this.blob.readStorageKey(variant.storageKey));
        }
      })
    );
    const audioBlobKey = content.audioEtag
      ? audioBlobContentId(contentId, content.audioEtag)
      : null;
    return {
      content,
      source,
      sourceBytes,
      variants,
      variantBytes,
      legacyImageBytes: await this.blob.read(gid, contentId, 'image'),
      audioBlobKey,
      audioBytes: audioBlobKey ? await this.blob.read(gid, audioBlobKey, 'audio') : null,
    };
  }

  private async buildStaticReplacementForwardSnapshot(input: {
    gid: string;
    contentId: string;
    image: RenderedImageUpload;
    note4: VariantRenderResult;
  }): Promise<StaticContentSnapshot> {
    if (!input.note4.storageKey) {
      throw new ValidationError('Note4 图片变体缺少存储位置', {
        code: 'note4_variant_missing_blob',
      });
    }
    const note4Bytes = await this.blob.readStorageKey(input.note4.storageKey);
    if (!note4Bytes) {
      throw new ValidationError('Note4 图片变体文件不存在', {
        code: 'note4_variant_missing_blob',
      });
    }
    const snapshot = await this.snapshotStaticContent(input.gid, input.contentId);
    return {
      ...snapshot,
      content: {
        ...snapshot.content,
        imageEtag: input.note4.frameEtag ?? computeETag(note4Bytes),
        imageSize: input.note4.frameSize ?? note4Bytes.byteLength,
      },
      sourceBytes: Buffer.from(input.image.bytes),
      legacyImageBytes: Buffer.from(note4Bytes),
    };
  }

  private async restoreStaticReplacementOrThrow(input: {
    gid: string;
    contentId: string;
    snapshot: StaticContentSnapshot;
    sourceKey: string;
    newAudioEtag: string | null;
    variantResults: VariantRenderResult[];
    forwardSnapshot: StaticContentSnapshot | null;
    originalErr: unknown;
  }): Promise<void> {
    const forwardSnapshot =
      input.forwardSnapshot ?? (await this.snapshotStaticContent(input.gid, input.contentId));
    const oldBlobRestore = await this.restoreStaticReplacementBlobs(input);
    if (oldBlobRestore.length > 0) {
      await this.rollForwardStaticReplacementOrThrow(input, forwardSnapshot, oldBlobRestore);
    }
    try {
      await this.restoreStaticReplacementDb(input.gid, input.contentId, input.snapshot);
    } catch (rollbackErr: unknown) {
      await this.rollForwardStaticReplacementOrThrow(input, forwardSnapshot, rollbackErr);
    }
  }

  private async rollForwardStaticReplacementOrThrow(
    input: {
      gid: string;
      contentId: string;
      snapshot: StaticContentSnapshot;
      sourceKey: string;
      originalErr: unknown;
    },
    forwardSnapshot: StaticContentSnapshot,
    rollbackErr: unknown
  ): Promise<never> {
    const rollForwardErrors: unknown[] = [];
    rollForwardErrors.push(
      ...(await this.restoreStaticReplacementBlobs({
        ...input,
        snapshot: forwardSnapshot,
        newAudioEtag: null,
        variantResults: [],
        extraStorageKeysToDelete: storageKeysMissingFrom(input.snapshot, forwardSnapshot),
        extraAudioBlobKeysToDelete: audioBlobKeysMissingFrom(input.snapshot, forwardSnapshot),
      }))
    );
    try {
      await this.restoreStaticReplacementDb(input.gid, input.contentId, forwardSnapshot);
    } catch (err: unknown) {
      rollForwardErrors.push(err);
    }
    throw combinedStaticMutationError(
      'static_replace_compensation_failed',
      input.originalErr,
      rollbackErr,
      rollForwardErrors.length > 0 ? rollForwardErrors : undefined
    );
  }

  private async restoreStaticReplacementDb(
    gid: string,
    contentId: string,
    snapshot: StaticContentSnapshot
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockGroupRow(tx, gid);
      await tx.content.update({ where: { id: contentId }, data: snapshot.content });
      if (snapshot.source) {
        await tx.contentSource.upsert({
          where: { contentId },
          create: { contentId, ...sourceSnapshotData(snapshot.source) },
          update: sourceSnapshotData(snapshot.source),
        });
      } else {
        await tx.contentSource.deleteMany({ where: { contentId } });
      }
      await tx.contentVariant.deleteMany({ where: { contentId } });
      if (snapshot.variants.length > 0) {
        await tx.contentVariant.createMany({ data: snapshot.variants.map(variantSnapshotData) });
      }
      await this.groups.recomputeManifestEtag(gid, tx);
    });
  }

  private async restoreStaticReplacementBlobs(input: {
    gid: string;
    contentId: string;
    snapshot: StaticContentSnapshot;
    sourceKey: string;
    newAudioEtag: string | null;
    variantResults: VariantRenderResult[];
    extraStorageKeysToDelete?: Set<string>;
    extraAudioBlobKeysToDelete?: Set<string>;
  }): Promise<unknown[]> {
    const snapshotVariantKeys = new Set(input.snapshot.variantBytes.keys());
    const operations: Array<Promise<void>> = [];
    if (input.snapshot.source?.storageKey) {
      operations.push(
        this.restoreStorageKey(input.snapshot.source.storageKey, input.snapshot.sourceBytes)
      );
      if (input.snapshot.source.storageKey !== input.sourceKey) {
        operations.push(this.blob.deleteStorageKey(input.sourceKey));
      }
    } else {
      operations.push(this.blob.deleteStorageKey(input.sourceKey));
    }
    operations.push(
      ...[...input.snapshot.variantBytes.entries()].map(([storageKey, bytes]) =>
        this.restoreStorageKey(storageKey, bytes)
      )
    );
    operations.push(
      ...input.variantResults
        .filter(
          (result) =>
            result.changed && result.storageKey && !snapshotVariantKeys.has(result.storageKey)
        )
        .map((result) => this.blob.deleteStorageKey(result.storageKey!))
    );
    operations.push(
      ...[...(input.extraStorageKeysToDelete ?? [])].map((storageKey) =>
        this.blob.deleteStorageKey(storageKey)
      )
    );
    if (input.snapshot.legacyImageBytes) {
      operations.push(
        this.blob.write(input.gid, input.contentId, 'image', input.snapshot.legacyImageBytes).then()
      );
    } else {
      operations.push(this.blob.delete(input.gid, input.contentId, 'image'));
    }
    if (input.snapshot.audioBlobKey && input.snapshot.audioBytes) {
      operations.push(
        this.blob
          .write(input.gid, input.snapshot.audioBlobKey, 'audio', input.snapshot.audioBytes)
          .then()
      );
    }
    const oldAudioEtag = input.snapshot.content.audioEtag;
    if (input.newAudioEtag && input.newAudioEtag !== oldAudioEtag) {
      operations.push(
        this.blob.delete(
          input.gid,
          audioBlobContentId(input.contentId, input.newAudioEtag),
          'audio'
        )
      );
    }
    operations.push(
      ...[...(input.extraAudioBlobKeysToDelete ?? [])].map((audioBlobKey) =>
        this.blob.delete(input.gid, audioBlobKey, 'audio')
      )
    );
    const settled = await Promise.allSettled(operations);
    return settled
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
  }

  private async restoreStorageKey(storageKey: string, previousBytes: Buffer | null): Promise<void> {
    if (previousBytes) {
      const kind = storageKey.startsWith('sources/') ? 'source' : 'frame';
      await this.blob.writeStorageKey(storageKey, kind, previousBytes);
    } else {
      await this.blob.deleteStorageKey(storageKey);
    }
  }

  private async cleanupChangedVariantFrames(results: VariantRenderResult[]): Promise<void> {
    await Promise.all(
      results
        .filter((result) => result.changed && result.storageKey)
        .map((result) =>
          this.blob.deleteStorageKey(result.storageKey!).catch((err: unknown) => {
            this.logger.warn(
              `Variant blob rollback failed for ${result.profileId}: ${formatError(err)}`
            );
          })
        )
    );
  }

  private async compensateCreatedContentOrThrow(
    gid: string,
    contentId: string,
    originalErr: unknown
  ): Promise<void> {
    try {
      await this.withGroupMutation(gid, async (tx) => {
        await tx.content.delete({ where: { id: contentId } });
        await compactContentSortOrders(tx, gid);
        return {};
      });
    } catch (rollbackErr: unknown) {
      throw combinedStaticMutationError(
        'static_create_compensation_failed',
        originalErr,
        rollbackErr
      );
    }
  }

  private async deleteSourceBlobAfterCompensation(
    gid: string,
    contentId: string,
    sourceKey: string
  ): Promise<void> {
    await this.blob.deleteStorageKey(sourceKey).catch((rollbackErr: unknown) => {
      this.logger.warn(
        `Source blob rollback failed for created content ${contentId} in group ${gid}: ${formatError(rollbackErr)}`
      );
    });
  }

  private async requireContent(contentId: string): Promise<{
    id: string;
    groupId: string;
    sortOrder: number;
    kind: ContentKind;
    imageEtag: string;
    audioEtag: string | null;
    audioSource: ContentAudioSource | null;
  }> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: {
        id: true,
        groupId: true,
        sortOrder: true,
        kind: true,
        imageEtag: true,
        audioEtag: true,
        audioSource: true,
      },
    });
    if (!content) throw new NotFoundError('内容不存在');
    return content;
  }

  private async requireOwnedContent(
    contentId: string,
    ownerUserId: string
  ): ReturnType<ContentsService['requireContent']> {
    const content = await this.requireContent(contentId);
    await this.groups.assertOwned(content.groupId, ownerUserId);
    return content;
  }

  private async withGroupMutation<T extends object>(
    gid: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T & { groupEtag: string }> {
    return this.prisma.$transaction(async (tx) => {
      await lockGroupRow(tx, gid);
      const result = await fn(tx);
      const groupEtag = await this.groups.recomputeManifestEtag(gid, tx);
      return { ...result, groupEtag };
    });
  }

  private async cleanupAudioBlobAfterCommit(
    groupId: string,
    contentId: string,
    audioEtag: string | null
  ): Promise<void> {
    if (!audioEtag) return;
    await this.audioBlobs.delete(groupId, contentId, audioEtag).catch((err: unknown) => {
      this.logger.warn(
        `Post-commit audio blob cleanup failed for content ${contentId} in group ${groupId}: ${formatError(err)}`
      );
    });
  }
}

function readySourceData(
  image: RenderedImageUpload
): Prisma.ContentSourceCreateWithoutContentInput {
  return {
    status: 'ready',
    sourceEtag: image.etag,
    mimeType: image.mimeType,
    size: image.size,
    storageKey: image.storageKey,
  };
}

function sourceSnapshotData(source: ContentSource): Prisma.ContentSourceCreateWithoutContentInput {
  return {
    status: source.status,
    sourceEtag: source.sourceEtag,
    mimeType: source.mimeType,
    size: source.size,
    storageKey: source.storageKey,
  };
}

function variantSnapshotData(variant: ContentVariant): Prisma.ContentVariantCreateManyInput {
  return {
    id: variant.id,
    contentId: variant.contentId,
    profileId: variant.profileId,
    status: variant.status,
    pixelFormat: variant.pixelFormat,
    frameCodec: variant.frameCodec,
    width: variant.width,
    height: variant.height,
    frameEtag: variant.frameEtag,
    frameSize: variant.frameSize,
    storageKey: variant.storageKey,
    renderVersion: variant.renderVersion,
    lastError: variant.lastError,
    leaseUntil: variant.leaseUntil,
    attempts: variant.attempts,
  };
}

function storageKeysMissingFrom(
  from: StaticContentSnapshot,
  to: StaticContentSnapshot
): Set<string> {
  const toKeys = new Set<string>();
  if (to.source?.storageKey) toKeys.add(to.source.storageKey);
  for (const key of to.variantBytes.keys()) toKeys.add(key);

  const missing = new Set<string>();
  if (from.source?.storageKey && !toKeys.has(from.source.storageKey)) {
    missing.add(from.source.storageKey);
  }
  for (const key of from.variantBytes.keys()) {
    if (!toKeys.has(key)) missing.add(key);
  }
  return missing;
}

function audioBlobKeysMissingFrom(
  from: StaticContentSnapshot,
  to: StaticContentSnapshot
): Set<string> {
  if (!from.audioBlobKey || from.audioBlobKey === to.audioBlobKey) return new Set();
  return new Set([from.audioBlobKey]);
}

function combinedStaticMutationError(
  code: 'static_create_compensation_failed' | 'static_replace_compensation_failed',
  originalErr: unknown,
  rollbackErr: unknown,
  rollForwardErr?: unknown
): InternalError {
  const rollbackMessage = formatStaticMutationFailure(rollbackErr);
  const rollForwardMessage =
    rollForwardErr === undefined ? null : formatStaticMutationFailure(rollForwardErr);
  return new InternalError(
    `${code}: ${formatError(originalErr)}; rollback: ${rollbackMessage}${
      rollForwardMessage ? `; roll-forward: ${rollForwardMessage}` : ''
    }`,
    {
      code,
      original_error: formatError(originalErr),
      rollback_error: rollbackMessage,
      ...(rollForwardMessage ? { roll_forward_error: rollForwardMessage } : {}),
    }
  );
}

function formatStaticMutationFailure(err: unknown): string {
  if (Array.isArray(err)) {
    return err.map((item) => formatError(item)).join('; ');
  }
  return formatError(err);
}
