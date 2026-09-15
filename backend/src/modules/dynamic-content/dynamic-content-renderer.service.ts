import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type ContentVariant } from '@prisma/client';
import { DEFAULT_DISPLAY_PROFILE_ID } from 'shared';
import { BlobService } from '../../infra/blob/blob.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { toPrismaInputJson } from '../../common/db/prisma-json';
import { computeETag } from '../../common/utils/etag';
import { InternalError, NotFoundError, ValidationError } from '../../common/errors';
import { formatError } from '../../common/utils/error-format';
import { ContentMutationCoordinator } from '../../common/worker/content-mutation-coordinator';
import { GroupsService } from '../groups/groups.service';
import { DynamicFrameRendererService } from './rendering/dynamic-frame-renderer.service';
import {
  NOTE4_RENDER_TARGET,
  renderTargetForProfile,
  type RenderTarget,
} from '../rendering/render-target';
import {
  VariantRenderService,
  type VariantRenderResult,
} from '../rendering/variant-render.service';
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
  dynamicNextRunAt: true,
  dynamicRefreshDueAt: true,
  dynamicRefreshLeaseUntil: true,
  dynamicRefreshAttempts: true,
  dynamicLastError: true,
} as const satisfies Prisma.ContentSelect;

type DynamicRenderContentRow = Prisma.ContentGetPayload<{
  select: typeof DYNAMIC_RENDER_CONTENT_SELECT;
}>;

type DynamicContentSnapshot = Pick<
  DynamicRenderContentRow,
  | 'id'
  | 'groupId'
  | 'imageEtag'
  | 'imageSize'
  | 'dynamicData'
  | 'dynamicLastRunAt'
  | 'dynamicNextRunAt'
  | 'dynamicRefreshDueAt'
  | 'dynamicRefreshLeaseUntil'
  | 'dynamicRefreshAttempts'
  | 'dynamicLastError'
>;

interface DynamicRenderSnapshot {
  content: DynamicContentSnapshot;
  legacyImage: Buffer | null;
  variants: ContentVariant[];
  variantBytes: Map<string, Buffer | null>;
}

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly registry: DynamicContentRegistry,
    private readonly renderer: DynamicFrameRendererService,
    private readonly variantRenderer: VariantRenderService,
    private readonly groups: GroupsService,
    private readonly dynamicAudio: DynamicAudioService,
    private readonly contentMutations: ContentMutationCoordinator = ContentMutationCoordinator.default()
  ) {}

  renderDynamicContent(
    contentId: string,
    opts: RenderDynamicContentOptions = {}
  ): Promise<RenderDynamicContentResult> {
    const canDedupe = !opts.force && opts.dataOverride === undefined;
    const existing = canDedupe ? this.inflight.get(contentId) : undefined;
    if (existing) return existing;

    const task = canDedupe
      ? this.contentMutations.run(contentId, () => this.doRender(contentId, opts))
      : this.contentMutations.run(contentId, () => this.doRender(contentId, opts), {
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
    dataOverride?: unknown,
    displayProfileId = DEFAULT_DISPLAY_PROFILE_ID
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
      target: renderTargetForProfile(displayProfileId),
    });
  }

  async renderPreview(
    contentId: string,
    ownerUserId: string,
    configOverride: unknown,
    frameNameOverride?: string | null,
    displayProfileId = DEFAULT_DISPLAY_PROFILE_ID
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
      target: renderTargetForProfile(displayProfileId),
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
      await this.markErrorIfRendererOwned(content, `配置非法: ${message}`, now);
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
        await this.markErrorIfRendererOwned(content, message, now);
        throw err;
      }
      data = content.dynamicData;
    }

    const renderContext = {
      type: content.dynamicType,
      frameName: content.frameName,
      config: (config ?? {}) as Record<string, unknown>,
      data: normalizeRenderData(data),
      renderedAt: now,
    };
    const snapshot = await this.snapshotDynamicRender(content);
    let note4: VariantRenderResult;
    let mirrored: { etag: string; size: number; previousImage: Buffer | null };
    try {
      const variants = await this.variantRenderer.renderContentVariants({
        groupId: content.groupId,
        contentId,
        render: (target) => this.renderAndValidate({ ...renderContext, target }),
      });
      note4 = this.requireReadyNote4(variants.results);
      mirrored = await this.mirrorNote4ToLegacy(content.groupId, contentId, note4);
    } catch (err) {
      let forwardSnapshot: DynamicRenderSnapshot;
      try {
        forwardSnapshot = await this.snapshotDynamicRenderState(snapshot.content);
      } catch (forwardSnapshotErr) {
        await this.restoreDynamicRenderSnapshot(snapshot, err, undefined, forwardSnapshotErr);
        await this.markErrorIfRendererOwned(content, renderFailureMessage(err), now);
        throw new ForwardSnapshotCaptureError(err, forwardSnapshotErr);
      }
      await this.restoreDynamicRenderSnapshot(snapshot, err, forwardSnapshot);
      await this.markErrorIfRendererOwned(content, renderFailureMessage(err), now);
      throw err;
    }
    const imageEtag = mirrored.etag;
    const schedule = computeDynamicRefreshSchedule({
      dynamicType: content.dynamicType,
      config,
      now,
      defaultTtlSec: this.registry.defaultTtlSec(content.dynamicType),
    });

    const dynamicData = data == null ? null : data;
    if (!opts.force && imageEtag === content.imageEtag) {
      let forwardSnapshot: DynamicRenderSnapshot | undefined;
      try {
        const finalContent = dynamicContentSnapshotFrom(content, {
          dynamicData,
          dynamicLastRunAt: now,
          dynamicNextRunAt: schedule.nextRunAt,
          dynamicRefreshDueAt: schedule.refreshDueAt,
          dynamicRefreshLeaseUntil: null,
          dynamicRefreshAttempts: 0,
          dynamicLastError: fetchErrorMessage ? fetchErrorMessage.slice(0, 512) : null,
        });
        forwardSnapshot = await this.snapshotDynamicRenderState(finalContent);
        await this.prisma.content.update({
          where: { id: contentId },
          data: {
            dynamicData: dynamicData == null ? Prisma.JsonNull : toPrismaInputJson(dynamicData),
            dynamicLastRunAt: now,
            dynamicNextRunAt: schedule.nextRunAt,
            dynamicRefreshDueAt: schedule.refreshDueAt,
            dynamicRefreshLeaseUntil: null,
            dynamicRefreshAttempts: 0,
            dynamicLastError: fetchErrorMessage ? fetchErrorMessage.slice(0, 512) : null,
          },
        });
      } catch (err) {
        await this.restoreDynamicRenderSnapshot(snapshot, err, forwardSnapshot);
        await this.markErrorIfRendererOwned(content, formatError(err), now);
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
        unchanged: !audioSync.changed,
      };
    }

    let forwardSnapshot: DynamicRenderSnapshot | undefined;
    try {
      const finalContent = dynamicContentSnapshotFrom(content, {
        imageEtag,
        imageSize: mirrored.size,
        dynamicData,
        dynamicLastRunAt: now,
        dynamicNextRunAt: schedule.nextRunAt,
        dynamicRefreshDueAt: schedule.refreshDueAt,
        dynamicRefreshLeaseUntil: null,
        dynamicRefreshAttempts: 0,
        dynamicLastError: fetchErrorMessage ? fetchErrorMessage.slice(0, 512) : null,
      });
      forwardSnapshot = await this.snapshotDynamicRenderState(finalContent);
      await this.prisma.content.update({
        where: { id: contentId },
        data: {
          imageEtag,
          imageSize: mirrored.size,
          dynamicData: dynamicData == null ? Prisma.JsonNull : toPrismaInputJson(dynamicData),
          dynamicLastRunAt: now,
          dynamicNextRunAt: schedule.nextRunAt,
          dynamicRefreshDueAt: schedule.refreshDueAt,
          dynamicRefreshLeaseUntil: null,
          dynamicRefreshAttempts: 0,
          dynamicLastError: fetchErrorMessage ? fetchErrorMessage.slice(0, 512) : null,
        },
      });
    } catch (err) {
      await this.restoreDynamicRenderSnapshot(snapshot, err, forwardSnapshot);
      await this.markErrorIfRendererOwned(content, formatError(err), now);
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
    input: Parameters<DynamicFrameRendererService['render']>[0] & { target?: RenderTarget }
  ): Promise<Buffer> {
    const target = input.target ?? NOTE4_RENDER_TARGET;
    const rendered = await this.renderer.render(input, target);
    if (rendered.byteLength !== target.byteLength) {
      throw new Error(`动态帧大小不匹配: ${rendered.byteLength}`);
    }
    return rendered;
  }

  private requireReadyNote4(results: VariantRenderResult[]): VariantRenderResult {
    const note4 = results.find((variant) => variant.profileId === NOTE4_RENDER_TARGET.profileId);
    if (
      note4?.status === 'ready' &&
      note4.storageKey &&
      note4.frameEtag &&
      note4.frameSize !== undefined &&
      !note4.error
    ) {
      return note4;
    }
    throw new ValidationError('Note4 动态变体渲染失败，内容未保存', {
      code: 'note4_dynamic_variant_required',
      error: note4?.error,
    });
  }

  private async snapshotDynamicRender(
    content: DynamicRenderContentRow
  ): Promise<DynamicRenderSnapshot> {
    return this.snapshotDynamicRenderState(dynamicContentSnapshotFrom(content));
  }

  private async snapshotDynamicRenderState(
    content: DynamicContentSnapshot
  ): Promise<DynamicRenderSnapshot> {
    const variants = await this.prisma.contentVariant.findMany({
      where: { contentId: content.id },
    });
    const variantBytes = new Map<string, Buffer | null>();
    for (const variant of variants) {
      if (variant.storageKey && !variantBytes.has(variant.storageKey)) {
        variantBytes.set(variant.storageKey, await this.blob.readStorageKey(variant.storageKey));
      }
    }
    return {
      content,
      legacyImage: await this.blob.read(content.groupId, content.id, 'image'),
      variants,
      variantBytes,
    };
  }

  private async restoreDynamicRenderSnapshot(
    snapshot: DynamicRenderSnapshot,
    originalErr: unknown,
    forwardSnapshot?: DynamicRenderSnapshot,
    forwardSnapshotErr?: unknown
  ): Promise<void> {
    try {
      await this.restoreDynamicRenderSnapshotOrThrow(snapshot);
    } catch (rollbackErr) {
      if (forwardSnapshot) {
        await this.rollForwardDynamicRenderSnapshot(originalErr, rollbackErr, forwardSnapshot);
      }
      throw new InternalRenderRollbackError(
        originalErr,
        rollbackErr,
        undefined,
        forwardSnapshotErr
      );
    }
  }

  private async restoreDynamicRenderSnapshotOrThrow(
    snapshot: DynamicRenderSnapshot
  ): Promise<void> {
    const currentVariants = await this.prisma.contentVariant.findMany({
      where: { contentId: snapshot.content.id },
    });
    const storageKeys = new Set<string>();
    for (const variant of currentVariants) {
      if (variant.storageKey) storageKeys.add(variant.storageKey);
    }
    for (const variant of snapshot.variants) {
      if (variant.storageKey) storageKeys.add(variant.storageKey);
    }

    for (const storageKey of storageKeys) {
      if (snapshot.variantBytes.has(storageKey)) {
        const bytes = snapshot.variantBytes.get(storageKey);
        if (bytes) await this.blob.writeStorageKey(storageKey, 'frame', bytes);
        else await this.blob.deleteStorageKey(storageKey);
      } else {
        await this.blob.deleteStorageKey(storageKey);
      }
    }

    if (snapshot.legacyImage) {
      await this.blob.write(
        snapshot.content.groupId,
        snapshot.content.id,
        'image',
        snapshot.legacyImage
      );
    } else {
      await this.blob.delete(snapshot.content.groupId, snapshot.content.id, 'image');
    }

    await this.restoreDynamicRenderDb(snapshot);
  }

  private async rollForwardDynamicRenderSnapshot(
    originalErr: unknown,
    rollbackErr: unknown,
    forwardSnapshot: DynamicRenderSnapshot
  ): Promise<void> {
    try {
      await this.restoreDynamicRenderSnapshotOrThrow(forwardSnapshot);
    } catch (rollForwardErr) {
      throw new InternalRenderRollbackError(originalErr, rollbackErr, rollForwardErr);
    }
  }

  private async restoreDynamicRenderDb(snapshot: DynamicRenderSnapshot): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.content.update({
        where: { id: snapshot.content.id },
        data: restoreDynamicContentInput(snapshot.content),
      });
      await tx.contentVariant.deleteMany({ where: { contentId: snapshot.content.id } });
      if (snapshot.variants.length > 0) {
        await tx.contentVariant.createMany({ data: snapshot.variants });
      }
    });
  }

  private async mirrorNote4ToLegacy(
    groupId: string,
    contentId: string,
    note4: VariantRenderResult
  ): Promise<{ etag: string; size: number; previousImage: Buffer | null }> {
    if (!note4.storageKey) {
      throw new ValidationError('Note4 动态变体缺少存储位置', {
        code: 'note4_dynamic_variant_missing_blob',
      });
    }
    const frame = await this.blob.readStorageKey(note4.storageKey);
    if (!frame) {
      throw new ValidationError('Note4 动态变体文件不存在', {
        code: 'note4_dynamic_variant_missing_blob',
      });
    }
    const previousImage = await this.blob.read(groupId, contentId, 'image');
    await this.blob.write(groupId, contentId, 'image', frame);
    return {
      etag: note4.frameEtag ?? computeETag(frame),
      size: note4.frameSize ?? frame.byteLength,
      previousImage,
    };
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

  private async markErrorIfRendererOwned(
    content: Pick<
      DynamicRenderContentRow,
      'id' | 'dynamicRefreshAttempts' | 'dynamicRefreshLeaseUntil'
    >,
    message: string,
    now: Date
  ): Promise<void> {
    if (content.dynamicRefreshLeaseUntil) return;
    await this.markError(content, message, now);
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

function restoreDynamicContentInput(content: DynamicContentSnapshot): Prisma.ContentUpdateInput {
  return {
    imageEtag: content.imageEtag,
    imageSize: content.imageSize,
    dynamicData:
      content.dynamicData === null || content.dynamicData === undefined
        ? Prisma.JsonNull
        : toPrismaInputJson(content.dynamicData),
    dynamicLastRunAt: content.dynamicLastRunAt,
    dynamicNextRunAt: content.dynamicNextRunAt,
    dynamicRefreshDueAt: content.dynamicRefreshDueAt,
    dynamicRefreshLeaseUntil: content.dynamicRefreshLeaseUntil,
    dynamicRefreshAttempts: content.dynamicRefreshAttempts,
    dynamicLastError: content.dynamicLastError,
  };
}

function dynamicContentSnapshotFrom(
  content: Pick<
    DynamicContentSnapshot,
    | 'id'
    | 'groupId'
    | 'imageEtag'
    | 'imageSize'
    | 'dynamicData'
    | 'dynamicLastRunAt'
    | 'dynamicNextRunAt'
    | 'dynamicRefreshDueAt'
    | 'dynamicRefreshLeaseUntil'
    | 'dynamicRefreshAttempts'
    | 'dynamicLastError'
  >,
  overrides: Partial<DynamicContentSnapshot> = {}
): DynamicContentSnapshot {
  return {
    id: content.id,
    groupId: content.groupId,
    imageEtag: content.imageEtag,
    imageSize: content.imageSize,
    dynamicData: content.dynamicData,
    dynamicLastRunAt: content.dynamicLastRunAt,
    dynamicNextRunAt: content.dynamicNextRunAt,
    dynamicRefreshDueAt: content.dynamicRefreshDueAt,
    dynamicRefreshLeaseUntil: content.dynamicRefreshLeaseUntil,
    dynamicRefreshAttempts: content.dynamicRefreshAttempts,
    dynamicLastError: content.dynamicLastError,
    ...overrides,
  };
}

function isRequiredNote4Failure(err: unknown): boolean {
  return (
    err instanceof ValidationError &&
    typeof err.detail === 'object' &&
    err.detail !== null &&
    (err.detail as { code?: unknown }).code === 'note4_dynamic_variant_required'
  );
}

function renderFailureMessage(err: unknown): string {
  return isRequiredNote4Failure(err) ? note4ErrorMessage(err) : formatError(err);
}

function note4ErrorMessage(err: unknown): string {
  if (
    err instanceof ValidationError &&
    typeof err.detail === 'object' &&
    err.detail !== null &&
    typeof (err.detail as { error?: unknown }).error === 'string'
  ) {
    return (err.detail as { error: string }).error;
  }
  return formatError(err);
}

class InternalRenderRollbackError extends InternalError {
  constructor(
    originalErr: unknown,
    rollbackErr: unknown,
    rollForwardErr?: unknown,
    forwardSnapshotErr?: unknown
  ) {
    super('动态渲染失败，且回滚未完成', {
      code: 'dynamic_render_rollback_failed',
      original_error: formatError(originalErr),
      ...(forwardSnapshotErr ? { forward_snapshot_error: formatError(forwardSnapshotErr) } : {}),
      rollback_error: formatError(rollbackErr),
      ...(rollForwardErr ? { roll_forward_error: formatError(rollForwardErr) } : {}),
    });
  }
}

class ForwardSnapshotCaptureError extends InternalError {
  constructor(originalErr: unknown, forwardSnapshotErr: unknown) {
    super('动态渲染 forward snapshot 获取失败', {
      code: 'dynamic_render_forward_snapshot_failed',
      original_error: formatError(originalErr),
      forward_snapshot_error: formatError(forwardSnapshotErr),
    });
  }
}
