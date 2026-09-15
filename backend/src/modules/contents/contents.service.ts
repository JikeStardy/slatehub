import { createId } from '@paralleldrive/cuid2';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ContentAudioSource, ContentKind } from '@prisma/client';
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
import { NOTE4_RENDER_TARGET } from '../dynamic-content/rendering/render-target';
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
    private readonly audioBlobs: ContentAudioBlobService
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
    let mutation: { seq: number; groupEtag: string; contentEtag: string };
    try {
      rollback.deleteCreated(gid, contentId, 'image');
      await this.blob.write(gid, contentId, 'image', image.bytes);
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
          },
          select: { contentEtag: true },
        });
        return { seq: nextSeq, contentEtag: created.contentEtag };
      });
    } catch (err) {
      await rollback.restoreAll();
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw new ConflictError('内容序号已存在');
      throw err;
    }
    return toContentMutationResponse(
      contentId,
      mutation.seq,
      image.etag,
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
      const previousImageBytes = await this.blob.read(gid, contentId, 'image');
      rollback.restorePrevious(gid, contentId, 'image', previousImageBytes);
      await this.blob.write(gid, contentId, 'image', upload.image.bytes);
      data.imageEtag = upload.image.etag;
      data.imageSize = upload.image.size;
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
      const sourceEtag = computeETag(parsed.imageBuf);
      const rendered = await this.imageRenderer.renderTo1bpp(parsed.imageBuf, NOTE4_RENDER_TARGET, {
        threshold: parsed.threshold,
        mode: parsed.mode,
        sourceEtag,
      });
      this.imageRenderer.validateFrameSize(rendered.data, NOTE4_RENDER_TARGET);
      image = {
        bytes: rendered.data,
        etag: computeETag(rendered.data),
        size: rendered.data.byteLength,
      };
    }

    let audio: RenderedAudioUpload | null = null;
    if (parsed.hasAudio && parsed.audioBuf) {
      const bytes = await this.audio.transcodeAudio(parsed.audioBuf, { signal });
      audio = { bytes, etag: computeETag(bytes), size: bytes.byteLength };
    }
    return { image, audio };
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
