import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { FRAME_BYTES } from 'shared';
import { BlobService } from '../../infra/blob/blob.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { toPrismaInputJson } from '../../common/db/prisma-json';
import { computeETag } from '../../common/utils/etag';
import { NotFoundError, ValidationError } from '../../common/errors';
import { formatError } from '../../common/utils/error-format';
import { KeyedPromiseQueue } from '../../common/worker/keyed-promise-queue';
import { GroupsService } from '../groups/groups.service';
import { DynamicFrameRendererService } from './rendering/dynamic-frame-renderer.service';
import { NOTE4_RENDER_TARGET } from './rendering/render-target';
import { DynamicContentRegistry } from './dynamic-content-registry';
import { DynamicAudioService } from './audio/dynamic-audio.service';
import { canReuseDynamicData } from './dynamic-data-reuse-policy';
import { computeDynamicRefreshSchedule, computeErrorBackoffAt } from './dynamic-refresh-policy';

const DYNAMIC_RENDER_CONTENT_SELECT = {
  id: true,
  groupId: true,
  frameName: true,
  imageEtag: true,
  audioEtag: true,
  imageSize: true,
  kind: true,
  dynamicType: true,
  dynamicConfig: true,
  dynamicData: true,
  dynamicLastRunAt: true,
  dynamicRefreshAttempts: true,
} as const satisfies Prisma.ContentSelect;

type DynamicRenderContentRow = Prisma.ContentGetPayload<{
  select: typeof DYNAMIC_RENDER_CONTENT_SELECT;
}>;

export interface RenderDynamicContentOptions {
  force?: boolean;
  dataOverride?: unknown;
  now?: Date;
}

export interface RenderDynamicContentResult {
  contentId: string;
  imageEtag: string;
  contentEtag: string;
  audioEtag: string | null;
  groupEtag: string;
  renderedAt: Date;
  unchanged: boolean;
}

@Injectable()
export class DynamicContentRendererService {
  private readonly logger = new Logger(DynamicContentRendererService.name);
  private readonly inflight = new Map<string, Promise<RenderDynamicContentResult>>();
  private readonly renderQueue = new KeyedPromiseQueue<RenderDynamicContentResult>({
    onPreviousError: (contentId, err) => {
      this.logger.warn(
        `Previous dynamic render failed for content ${contentId}: ${formatError(err)}`
      );
    },
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly registry: DynamicContentRegistry,
    private readonly renderer: DynamicFrameRendererService,
    private readonly groups: GroupsService,
    private readonly dynamicAudio: DynamicAudioService
  ) {}

  renderDynamicContent(
    contentId: string,
    opts: RenderDynamicContentOptions = {}
  ): Promise<RenderDynamicContentResult> {
    const canDedupe = !opts.force && opts.dataOverride === undefined;
    const existing = canDedupe ? this.inflight.get(contentId) : undefined;
    if (existing) return existing;

    const task = canDedupe
      ? this.renderQueue.run(contentId, () => this.doRender(contentId, opts))
      : this.renderQueue.run(contentId, () => this.doRender(contentId, opts), {
          continueAfterFailure: true,
        });

    if (canDedupe) {
      this.inflight.set(contentId, task);
      void task.then(
        () => {
          if (this.inflight.get(contentId) === task) this.inflight.delete(contentId);
        },
        () => {
          if (this.inflight.get(contentId) === task) this.inflight.delete(contentId);
        }
      );
    }
    return task;
  }

  async renderPreviewDirect(
    dynamicType: string,
    configOverride: unknown,
    frameName?: string | null,
    dataOverride?: unknown
  ): Promise<Buffer> {
    const entry = this.registry.get(dynamicType);
    if (!entry) throw new ValidationError(`未知动态类型: ${dynamicType}`);
    const config = entry.provider.validateConfig(configOverride);
    const now = new Date();
    const data =
      dataOverride === undefined
        ? await entry.provider.fetchData(config, { now, lastData: undefined })
        : dataOverride;
    return this.renderAndValidate({
      type: dynamicType,
      frameName,
      config: (config ?? {}) as Record<string, unknown>,
      data: normalizeRenderData(data),
      renderedAt: now,
    });
  }

  async renderPreview(
    contentId: string,
    ownerUserId: string,
    configOverride: unknown,
    frameNameOverride?: string | null
  ): Promise<Buffer> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: {
        id: true,
        frameName: true,
        imageSize: true,
        kind: true,
        dynamicType: true,
        dynamicData: true,
        dynamicLastRunAt: true,
        groupId: true,
        group: { select: { ownerUserId: true } },
      },
    });
    if (!content || content.group.ownerUserId !== ownerUserId)
      throw new NotFoundError('内容不存在');
    if (content.kind !== 'dynamic' || !content.dynamicType) {
      throw new ValidationError('该内容不是动态类型');
    }

    const entry = this.registry.get(content.dynamicType);
    if (!entry) throw new ValidationError(`未知动态类型: ${content.dynamicType}`);
    const config = entry.provider.validateConfig(configOverride);
    const now = new Date();
    let data: unknown;
    try {
      data = await entry.provider.fetchData(config, {
        now,
        lastData: content.dynamicData ?? undefined,
      });
    } catch (err) {
      if (
        !canReuseDynamicData(
          content.dynamicType,
          content.dynamicData,
          content.imageSize,
          config,
          now,
          content.dynamicLastRunAt
        )
      ) {
        throw err;
      }
      data = content.dynamicData;
    }
    const frameName = frameNameOverride === undefined ? content.frameName : frameNameOverride;
    return this.renderAndValidate({
      type: content.dynamicType,
      frameName,
      config: (config ?? {}) as Record<string, unknown>,
      data: normalizeRenderData(data),
      renderedAt: now,
    });
  }

  private async doRender(
    contentId: string,
    opts: RenderDynamicContentOptions
  ): Promise<RenderDynamicContentResult> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: DYNAMIC_RENDER_CONTENT_SELECT,
    });
    if (!content) throw new NotFoundError('内容不存在');
    if (content.kind !== 'dynamic' || !content.dynamicType) {
      throw new ValidationError('该内容不是动态类型');
    }
    const entry = this.registry.get(content.dynamicType);
    if (!entry) throw new ValidationError(`未知动态类型: ${content.dynamicType}`);
    const now = opts.now ?? new Date();

    let config: unknown;
    try {
      config = entry.provider.validateConfig(content.dynamicConfig);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.markError(content, `配置非法: ${message}`, now);
      throw new ValidationError(`动态配置非法: ${message}`);
    }

    let data: unknown;
    let fetchErrorMessage: string | null = null;
    try {
      if (opts.dataOverride !== undefined) {
        data = opts.dataOverride;
      } else {
        data = await entry.provider.fetchData(config, {
          now,
          lastData: content.dynamicData ?? undefined,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fetchErrorMessage = message;
      this.logger.warn(
        `Dynamic data fetch failed for content ${contentId} of type ${content.dynamicType}: ${message}`
      );
      await this.markError(content, message, now);
      if (
        !canReuseDynamicData(
          content.dynamicType,
          content.dynamicData,
          content.imageSize,
          config,
          now,
          content.dynamicLastRunAt
        )
      ) {
        throw err;
      }
      data = content.dynamicData;
    }

    const rendered = await this.renderAndValidate({
      type: content.dynamicType,
      frameName: content.frameName,
      config: (config ?? {}) as Record<string, unknown>,
      data: normalizeRenderData(data),
      renderedAt: now,
    });
    const imageEtag = computeETag(rendered);
    const schedule = computeDynamicRefreshSchedule({
      dynamicType: content.dynamicType,
      config,
      now,
      defaultTtlSec: this.registry.defaultTtlSec(content.dynamicType),
    });

    if (!opts.force && imageEtag === content.imageEtag) {
      await this.prisma.content.update({
        where: { id: contentId },
        data: {
          dynamicData: data == null ? Prisma.JsonNull : toPrismaInputJson(data),
          dynamicLastRunAt: now,
          dynamicNextRunAt: schedule.nextRunAt,
          dynamicRefreshDueAt: schedule.refreshDueAt,
          dynamicRefreshLeaseUntil: null,
          dynamicRefreshAttempts: 0,
          dynamicLastError: fetchErrorMessage ? fetchErrorMessage.slice(0, 512) : null,
        },
      });
      const audioSync = await this.syncDynamicAudioBestEffort(contentId, now);
      const etags = await this.groups.recomputeGroupEtags(content.groupId);
      return {
        contentId,
        imageEtag,
        contentEtag: contentEtagFromGroupEtags(etags.contentEtags, contentId, imageEtag),
        audioEtag: await this.responseAudioEtag(contentId, content.audioEtag, audioSync),
        groupEtag: etags.manifestEtag,
        renderedAt: now,
        unchanged: !audioSync.changed,
      };
    }

    const previousImage = await this.blob.read(content.groupId, content.id, 'image');
    await this.blob.write(content.groupId, content.id, 'image', rendered);
    try {
      await this.prisma.content.update({
        where: { id: contentId },
        data: {
          imageEtag,
          imageSize: rendered.byteLength,
          dynamicData: data == null ? Prisma.JsonNull : toPrismaInputJson(data),
          dynamicLastRunAt: now,
          dynamicNextRunAt: schedule.nextRunAt,
          dynamicRefreshDueAt: schedule.refreshDueAt,
          dynamicRefreshLeaseUntil: null,
          dynamicRefreshAttempts: 0,
          dynamicLastError: fetchErrorMessage ? fetchErrorMessage.slice(0, 512) : null,
        },
      });
    } catch (err) {
      if (previousImage) await this.blob.write(content.groupId, content.id, 'image', previousImage);
      else {
        await this.blob.delete(content.groupId, content.id, 'image').catch((deleteErr: unknown) => {
          this.logger.warn(
            `Failed to delete dynamic image after database update rollback for content ${contentId}: ${formatError(deleteErr)}`
          );
        });
      }
      throw err;
    }
    const audioSync = await this.syncDynamicAudioBestEffort(contentId, now);
    const etags = await this.groups.recomputeGroupEtags(content.groupId);
    return {
      contentId,
      imageEtag,
      contentEtag: contentEtagFromGroupEtags(etags.contentEtags, contentId, imageEtag),
      audioEtag: await this.responseAudioEtag(contentId, content.audioEtag, audioSync),
      groupEtag: etags.manifestEtag,
      renderedAt: now,
      unchanged: false,
    };
  }

  private async renderAndValidate(
    input: Parameters<DynamicFrameRendererService['render']>[0]
  ): Promise<Buffer> {
    const rendered = await this.renderer.render(input, NOTE4_RENDER_TARGET);
    if (rendered.byteLength !== FRAME_BYTES) {
      throw new Error(`动态帧大小不匹配: ${rendered.byteLength}`);
    }
    return rendered;
  }

  private async syncDynamicAudioBestEffort(
    contentId: string,
    now: Date
  ): Promise<{ changed: boolean; failed: boolean }> {
    try {
      return { changed: await this.dynamicAudio.sync(contentId, { now }), failed: false };
    } catch (err) {
      this.logger.warn(`Dynamic audio sync failed for content ${contentId}: ${formatError(err)}`);
      return { changed: false, failed: true };
    }
  }

  private async responseAudioEtag(
    contentId: string,
    fallback: string | null,
    audioSync: { changed: boolean; failed: boolean }
  ): Promise<string | null> {
    if (audioSync.changed) return null;
    if (!audioSync.failed) return fallback;
    try {
      const row = await this.prisma.content.findUnique({
        where: { id: contentId },
        select: { audioEtag: true },
      });
      return row?.audioEtag ?? null;
    } catch (err) {
      this.logger.warn(
        `Failed to read audio etag after dynamic audio sync failed for content ${contentId}: ${formatError(err)}`
      );
      return fallback;
    }
  }

  private async markError(
    content: Pick<DynamicRenderContentRow, 'id' | 'dynamicRefreshAttempts'>,
    message: string,
    now: Date
  ): Promise<void> {
    try {
      // 失败时按累计失败次数指数退避推进 dynamicNextRunAt/refreshDueAt。否则 nextRunAt
      // 停在过去 → nextWakeSec 返回 0 → 设备每最小间隔空醒重试，持续失败时耗电。
      // 渲染成功路径会把 attempts 清零（见 doRender 的 update），退避自然复位。
      const attempts = content.dynamicRefreshAttempts + 1;
      const backoffAt = computeErrorBackoffAt(attempts, now);
      await this.prisma.content.update({
        where: { id: content.id },
        data: {
          dynamicLastError: message.slice(0, 512),
          dynamicLastRunAt: now,
          dynamicRefreshAttempts: attempts,
          dynamicRefreshLeaseUntil: null,
          dynamicNextRunAt: backoffAt,
          dynamicRefreshDueAt: backoffAt,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to mark dynamic render error for content ${content.id}: ${formatError(err)}`
      );
    }
  }
}

function contentEtagFromGroupEtags(
  contentEtags: Array<{ id: string; etag: string }>,
  contentId: string,
  fallback: string
): string {
  return contentEtags.find((content) => content.id === contentId)?.etag ?? fallback;
}

function normalizeRenderData(data: unknown): Record<string, unknown> | null {
  if (data === null || data === undefined) return null;
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new ValidationError('动态数据必须是 JSON 对象或 null', {
      code: 'dynamic_data_invalid_shape',
    });
  }
  return data as Record<string, unknown>;
}
