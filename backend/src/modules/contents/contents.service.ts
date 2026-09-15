import { createId } from '@paralleldrive/cuid2';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ContentAudioSource, ContentKind, ContentSource } from '@prisma/client';
import { type ContentMutationResponseT } from 'shared';
import { BlobService } from '../../infra/blob/blob.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { computeETag } from '../../common/utils/etag';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors';
import { lockGroupRow } from '../../common/db/row-locks';
import { bulkSetContentSortOrder, compactContentSortOrders } from '../../common/db/bulk-sort-order';
import { validateOrderSet } from '../../common/db/order-validation';
import { nextContentSortOrder } from '../../common/db/sort-order';
import { formatError } from '../../common/utils/error-format';
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

@Injectable()
export class ContentsService {
  private readonly logger = new Logger(ContentsService.name);

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

  async patchFrameName(
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

  async delete(contentId: string, ownerUserId: string): Promise<void> {
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

  async deleteAudio(contentId: string, ownerUserId: string): Promise<{ manifest_etag: string }> {
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

  async generateImageTts(
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
      const note4 = await this.renderStaticVariants(gid, contentId, image, parsed);
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
      if (dbCreated) await this.rollbackCreatedContent(gid, contentId, err);
      await this.blob.deleteStorageKey(sourceKey).catch((rollbackErr: unknown) => {
        this.logger.warn(
          `Source blob rollback failed for created content ${contentId} in group ${gid}: ${formatError(rollbackErr)}`
        );
      });
      await rollback.restoreAll();
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
        let note4: VariantRenderResult;
        try {
          note4 = await this.renderStaticVariants(gid, contentId, image, parsed);
        } catch (err) {
          await this.restoreSourceAfterFailedImageUpdate(
            gid,
            contentId,
            previousSource,
            previousSourceBytes
          );
          throw err;
        }
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
  ): Promise<VariantRenderResult> {
    const result = await this.variantRenderer.renderContentVariants({
      groupId: gid,
      contentId,
      render: (target) => this.renderStaticFrame(image, target, parsed),
    });
    const note4 = result.results.find(
      (variant) => variant.profileId === NOTE4_RENDER_TARGET.profileId
    );
    if (
      note4?.status === 'ready' &&
      note4.storageKey &&
      note4.frameEtag &&
      note4.frameSize !== undefined
    ) {
      return note4;
    }
    await this.cleanupChangedVariantFrames(result.results);
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

  private async restoreSourceAfterFailedImageUpdate(
    gid: string,
    contentId: string,
    previousSource: ContentSource | null,
    previousBytes: Buffer | null
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (previousSource) {
        await tx.contentSource.upsert({
          where: { contentId },
          create: { contentId, ...sourceSnapshotData(previousSource) },
          update: sourceSnapshotData(previousSource),
        });
      } else {
        await tx.contentSource.deleteMany({ where: { contentId } });
      }
    });
    if (previousSource?.storageKey) {
      await this.restoreStorageKey(previousSource.storageKey, previousBytes);
    } else {
      await this.blob.deleteStorageKey(this.blob.sourceKey(gid, contentId));
    }
  }

  private async restoreStorageKey(storageKey: string, previousBytes: Buffer | null): Promise<void> {
    if (previousBytes) await this.blob.writeStorageKey(storageKey, 'source', previousBytes);
    else await this.blob.deleteStorageKey(storageKey);
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

  private async rollbackCreatedContent(
    gid: string,
    contentId: string,
    originalErr: unknown
  ): Promise<void> {
    await this.withGroupMutation(gid, async (tx) => {
      await tx.content.delete({ where: { id: contentId } });
      await compactContentSortOrders(tx, gid);
      return {};
    }).catch((rollbackErr: unknown) => {
      this.logger.warn(
        `Failed to roll back created content ${contentId} after static render error ${formatError(originalErr)}: ${formatError(rollbackErr)}`
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
