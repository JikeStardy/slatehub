import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { DEFAULT_DISPLAY_PROFILE_ID } from 'shared';
import { BlobService } from '../../infra/blob/blob.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { toPrismaInputJson } from '../../common/db/prisma-json';
import { InternalError, NotFoundError, ValidationError } from '../../common/errors';
import { formatError } from '../../common/utils/error-format';
import { ContentMutationCoordinator } from '../../common/worker/content-mutation-coordinator';
import { lockGroupRow } from '../../common/db/row-locks';
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

const RENDER_LEASE_MS = 180_000;
const CANDIDATE_GC_HORIZON_MS = 24 * 60 * 60 * 1000;
const CANDIDATE_GC_BATCH_SIZE = 50;
const CANDIDATE_GC_SCAN_LIMIT = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  dynamicRefreshLeaseToken: true,
  dynamicRefreshAttempts: true,
  dynamicLastError: true,
} as const satisfies Prisma.ContentSelect;

type DynamicRenderContentRow = Prisma.ContentGetPayload<{
  select: typeof DYNAMIC_RENDER_CONTENT_SELECT;
}>;

interface DynamicRenderLease {
  token: string;
  schedulerOwned: boolean;
  released?: boolean;
}

export interface RenderDynamicContentOptions {
  force?: boolean;
  dataOverride?: unknown;
  now?: Date;
  schedulerLeaseUntil?: Date;
  schedulerLeaseToken?: string;
  claimedLeaseOwner?: 'scheduler' | 'foreground';
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

interface FinalizeDynamicRenderResult {
  etags: { manifestEtag: string; contentEtags: Array<{ id: string; etag: string }> };
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

  async cleanupStaleDynamicRenderCandidates(now = new Date()): Promise<number> {
    const olderThan = new Date(now.getTime() - CANDIDATE_GC_HORIZON_MS);
    const scan = await this.blob.listStaleFrameCandidateKeys({
      olderThan,
      limit: CANDIDATE_GC_BATCH_SIZE,
      maxEntries: CANDIDATE_GC_SCAN_LIMIT,
    });
    const { candidates } = scan;
    if (candidates.length === 0) return 0;

    const storageKeys = candidates.map((candidate) => candidate.storageKey);
    let referencedRows: Array<{ storageKey: string | null }>;
    try {
      referencedRows = await this.prisma.contentVariant.findMany({
        where: { storageKey: { in: storageKeys } },
        select: { storageKey: true },
      });
    } catch (err) {
      this.logger.warn(
        `Preserving stale dynamic render candidates; failed to check variant references: ${formatError(err)}`
      );
      return 0;
    }

    const referenced = new Set(
      referencedRows.flatMap((row) => (row.storageKey ? [row.storageKey] : []))
    );
    let deleted = 0;
    await Promise.all(
      storageKeys.map(async (storageKey) => {
        if (referenced.has(storageKey)) return;
        await this.blob.deleteStorageKeyIfOlderThan(storageKey, 'frame', olderThan).then(
          (didDelete) => {
            if (!didDelete) return;
            deleted++;
          },
          (err: unknown) => {
            this.logger.warn(
              `Failed to clean stale dynamic render candidate ${storageKey}: ${formatError(err)}`
            );
          }
        );
      })
    );
    return deleted;
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
    const now = opts.now ?? new Date();
    const lease = await this.claimDynamicRenderLease(contentId, opts, now);
    try {
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

      let config: unknown;
      try {
        config = entry.provider.validateConfig(content.dynamicConfig);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.markErrorForLease(content, lease, `配置非法: ${message}`, now);
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
          await this.markErrorForLease(content, lease, message, now);
          throw err;
        }
        data = content.dynamicData;
      }

      let normalizedData: Record<string, unknown> | null;
      try {
        normalizedData = normalizeRenderData(data);
      } catch (err) {
        await this.markErrorForLease(content, lease, formatError(err), now);
        throw err;
      }

      const renderContext = {
        type: content.dynamicType,
        frameName: content.frameName,
        config: (config ?? {}) as Record<string, unknown>,
        data: normalizedData,
        renderedAt: now,
      };
      let note4: VariantRenderResult;
      let variants: VariantRenderResult[] = [];
      try {
        const outcome = await this.variantRenderer.renderContentVariantCandidates({
          groupId: content.groupId,
          contentId,
          attemptToken: lease.token,
          render: (target) => this.renderAndValidate({ ...renderContext, target }),
        });
        variants = outcome.results;
        note4 = this.requireReadyNote4(variants);
      } catch (err) {
        await this.cleanupCandidateBlobs(variants);
        await this.markErrorForLease(content, lease, renderFailureMessage(err), now);
        throw err;
      }
      const imageEtag = note4.frameEtag!;
      const imageSize = note4.frameSize!;
      let schedule: ReturnType<typeof computeDynamicRefreshSchedule>;
      try {
        schedule = computeDynamicRefreshSchedule({
          dynamicType: content.dynamicType,
          config,
          now,
          defaultTtlSec: this.registry.defaultTtlSec(content.dynamicType),
        });
      } catch (err) {
        await this.cleanupCandidateBlobs(variants);
        await this.markErrorForLease(content, lease, formatError(err), now);
        throw err;
      }

      const dynamicData = data == null ? null : data;
      let etags: { manifestEtag: string; contentEtags: Array<{ id: string; etag: string }> };
      if (!opts.force && imageEtag === content.imageEtag) {
        try {
          const finalized = await this.finalizeDynamicRender({
            content,
            variants,
            leaseToken: lease.token,
            data: {
              dynamicData: dynamicData == null ? Prisma.JsonNull : toPrismaInputJson(dynamicData),
              dynamicLastRunAt: now,
              dynamicNextRunAt: schedule.nextRunAt,
              dynamicRefreshDueAt: schedule.refreshDueAt,
              dynamicRefreshLeaseUntil: null,
              dynamicRefreshLeaseToken: null,
              dynamicRefreshAttempts: 0,
              dynamicLastError: fetchErrorMessage ? fetchErrorMessage.slice(0, 512) : null,
            },
          });
          etags = finalized.etags;
        } catch (err) {
          await this.markErrorForLease(content, lease, formatError(err), now);
          throw err;
        }
        const audioSync = await this.syncDynamicAudioBestEffort(contentId, now);
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

      try {
        const finalized = await this.finalizeDynamicRender({
          content,
          variants,
          leaseToken: lease.token,
          data: {
            imageEtag,
            imageSize,
            dynamicData: dynamicData == null ? Prisma.JsonNull : toPrismaInputJson(dynamicData),
            dynamicLastRunAt: now,
            dynamicNextRunAt: schedule.nextRunAt,
            dynamicRefreshDueAt: schedule.refreshDueAt,
            dynamicRefreshLeaseUntil: null,
            dynamicRefreshLeaseToken: null,
            dynamicRefreshAttempts: 0,
            dynamicLastError: fetchErrorMessage ? fetchErrorMessage.slice(0, 512) : null,
          },
        });
        etags = finalized.etags;
      } catch (err) {
        await this.markErrorForLease(content, lease, formatError(err), now);
        throw err;
      }
      const audioSync = await this.syncDynamicAudioBestEffort(contentId, now);
      return {
        contentId,
        imageEtag,
        contentEtag: contentEtagFromGroupEtags(etags.contentEtags, contentId, imageEtag),
        audioEtag: await this.responseAudioEtag(contentId, content.audioEtag, audioSync),
        groupEtag: etags.manifestEtag,
        renderedAt: now,
        unchanged: false,
      };
    } catch (err) {
      await this.releaseForegroundLeaseBestEffort(contentId, lease);
      throw err;
    }
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

  private async claimDynamicRenderLease(
    contentId: string,
    opts: RenderDynamicContentOptions,
    now: Date
  ): Promise<DynamicRenderLease> {
    if (opts.schedulerLeaseToken) {
      assertUuid('schedulerLeaseToken', opts.schedulerLeaseToken);
      return {
        token: opts.schedulerLeaseToken,
        schedulerOwned: opts.claimedLeaseOwner !== 'foreground',
      };
    }

    const token = randomUUID();
    const leaseUntil = new Date(now.getTime() + RENDER_LEASE_MS);
    const claimed = await this.prisma.content.updateMany({
      where: {
        id: contentId,
        kind: 'dynamic',
        OR: [{ dynamicRefreshLeaseUntil: null }, { dynamicRefreshLeaseUntil: { lte: now } }],
      },
      data: {
        dynamicRefreshLeaseUntil: leaseUntil,
        dynamicRefreshLeaseToken: token,
      },
    });
    if (claimed.count !== 1) await this.throwDynamicClaimFailure(contentId);
    return { token, schedulerOwned: false };
  }

  private async throwDynamicClaimFailure(contentId: string): Promise<never> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: { kind: true, dynamicType: true },
    });
    if (!content) throw new NotFoundError('内容不存在');
    if (content.kind !== 'dynamic' || !content.dynamicType) {
      throw new ValidationError('该内容不是动态类型');
    }
    throw new DynamicRenderLeaseLostError(contentId);
  }

  private async finalizeDynamicRender(input: {
    content: DynamicRenderContentRow;
    variants: VariantRenderResult[];
    leaseToken: string;
    data: Prisma.ContentUpdateInput;
  }): Promise<FinalizeDynamicRenderResult> {
    return this.prisma.$transaction(async (tx) => {
      await lockGroupRow(tx, input.content.groupId);
      const updated = await tx.content.updateMany({
        where: {
          id: input.content.id,
          kind: 'dynamic',
          dynamicRefreshLeaseToken: input.leaseToken,
        },
        data: input.data,
      });
      if (updated.count !== 1) throw new DynamicRenderLeaseLostError(input.content.id);

      const renderVersion = await this.nextVariantRenderVersion(tx, input.content.id);
      for (const variant of input.variants) {
        await this.commitVariantResult(tx, input.content.id, variant, renderVersion);
      }
      const etags = await this.groups.recomputeGroupEtags(input.content.groupId, tx);
      return { etags };
    });
  }

  private async nextVariantRenderVersion(
    tx: Prisma.TransactionClient,
    contentId: string
  ): Promise<number> {
    const variants = await tx.contentVariant.findMany({
      where: { contentId },
      select: { renderVersion: true },
    });
    return Math.max(0, ...variants.map((variant) => variant.renderVersion)) + 1;
  }

  private async commitVariantResult(
    tx: Prisma.TransactionClient,
    contentId: string,
    variant: VariantRenderResult,
    renderVersion: number
  ): Promise<void> {
    const target = renderTargetForProfile(variant.profileId);
    if (variant.status === 'ready') {
      const previous = await tx.contentVariant.findUnique({
        where: { contentId_profileId: { contentId, profileId: variant.profileId } },
      });
      if (
        previous?.status === 'ready' &&
        previous.storageKey &&
        previous.storageKey !== variant.storageKey
      ) {
        await this.blob.touchStorageKey(previous.storageKey, 'frame');
      }
      await tx.contentVariant.upsert({
        where: { contentId_profileId: { contentId, profileId: variant.profileId } },
        create: {
          contentId,
          profileId: variant.profileId,
          status: 'ready',
          pixelFormat: target.pixelFormat,
          frameCodec: target.frameCodec,
          width: target.width,
          height: target.height,
          frameEtag: variant.frameEtag!,
          frameSize: variant.frameSize!,
          storageKey: variant.storageKey!,
          renderVersion,
          lastError: null,
          leaseUntil: null,
          attempts: 0,
        },
        update: {
          status: 'ready',
          pixelFormat: target.pixelFormat,
          frameCodec: target.frameCodec,
          width: target.width,
          height: target.height,
          frameEtag: variant.frameEtag!,
          frameSize: variant.frameSize!,
          storageKey: variant.storageKey!,
          renderVersion,
          lastError: null,
          leaseUntil: null,
          attempts: 0,
        },
      });
      return;
    }

    const previous = await tx.contentVariant.findUnique({
      where: { contentId_profileId: { contentId, profileId: variant.profileId } },
    });
    const error = (variant.error ?? 'variant render failed').slice(0, 512);
    const attempts = (previous?.attempts ?? 0) + 1;
    const priorReady = previous?.status === 'ready' && previous.frameEtag && previous.storageKey;
    await tx.contentVariant.upsert({
      where: { contentId_profileId: { contentId, profileId: variant.profileId } },
      create: {
        contentId,
        profileId: variant.profileId,
        status: 'failed',
        pixelFormat: target.pixelFormat,
        frameCodec: target.frameCodec,
        width: target.width,
        height: target.height,
        frameEtag: null,
        frameSize: null,
        storageKey: null,
        renderVersion,
        lastError: error,
        leaseUntil: null,
        attempts,
      },
      update: priorReady
        ? {
            status: 'ready',
            lastError: error,
            leaseUntil: null,
            attempts,
          }
        : {
            status: 'failed',
            pixelFormat: target.pixelFormat,
            frameCodec: target.frameCodec,
            width: target.width,
            height: target.height,
            frameEtag: null,
            frameSize: null,
            storageKey: null,
            renderVersion,
            lastError: error,
            leaseUntil: null,
            attempts,
          },
    });
  }

  private async cleanupCandidateBlobs(results: VariantRenderResult[]): Promise<void> {
    await Promise.all(
      results.map(async (result) => {
        if (!result.storageKey) return;
        if (await this.candidateIsReferenced(result.storageKey)) return;
        await this.blob.deleteStorageKey(result.storageKey).catch((err: unknown) => {
          this.logger.warn(
            `Failed to clean dynamic render candidate ${result.storageKey}: ${formatError(err)}`
          );
        });
      })
    );
  }

  private async candidateIsReferenced(storageKey: string): Promise<boolean> {
    try {
      const rows = await this.prisma.contentVariant.findMany({
        where: { storageKey },
        select: { id: true },
        take: 1,
      });
      return rows.length > 0;
    } catch (err) {
      this.logger.warn(
        `Preserving dynamic render candidate ${storageKey}; failed to check variant references: ${formatError(err)}`
      );
      return true;
    }
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

  private async markErrorForLease(
    content: Pick<DynamicRenderContentRow, 'id' | 'dynamicRefreshAttempts'>,
    lease: DynamicRenderLease,
    message: string,
    now: Date
  ): Promise<void> {
    if (lease.schedulerOwned) return;
    try {
      // 失败时按累计失败次数指数退避推进 dynamicNextRunAt/refreshDueAt。否则 nextRunAt
      // 停在过去 → nextWakeSec 返回 0 → 设备每最小间隔空醒重试，持续失败时耗电。
      // 渲染成功路径会把 attempts 清零（见 doRender 的 update），退避自然复位。
      const attempts = content.dynamicRefreshAttempts + 1;
      const backoffAt = computeErrorBackoffAt(attempts, now);
      const updated = await this.prisma.content.updateMany({
        where: {
          id: content.id,
          kind: 'dynamic',
          dynamicRefreshLeaseToken: lease.token,
        },
        data: {
          dynamicLastError: message.slice(0, 512),
          dynamicLastRunAt: now,
          dynamicRefreshAttempts: attempts,
          dynamicRefreshLeaseUntil: null,
          dynamicRefreshLeaseToken: null,
          dynamicNextRunAt: backoffAt,
          dynamicRefreshDueAt: backoffAt,
        },
      });
      if (updated.count === 1) lease.released = true;
    } catch (err) {
      this.logger.error(
        `Failed to mark dynamic render error for content ${content.id}: ${formatError(err)}`
      );
    }
  }

  private async releaseForegroundLeaseBestEffort(
    contentId: string,
    lease: DynamicRenderLease
  ): Promise<void> {
    if (lease.schedulerOwned || lease.released) return;
    try {
      const updated = await this.prisma.content.updateMany({
        where: {
          id: contentId,
          kind: 'dynamic',
          dynamicRefreshLeaseToken: lease.token,
        },
        data: {
          dynamicRefreshLeaseUntil: null,
          dynamicRefreshLeaseToken: null,
        },
      });
      if (updated.count === 1) lease.released = true;
    } catch (err) {
      this.logger.warn(
        `Failed to release foreground dynamic render lease for content ${contentId}: ${formatError(err)}`
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

function assertUuid(name: string, value: string): void {
  if (!UUID_RE.test(value)) {
    throw new ValidationError(`非法 ${name}`, {
      code: 'invalid_uuid',
      field: name,
    });
  }
}

class DynamicRenderLeaseLostError extends InternalError {
  constructor(contentId: string) {
    super('动态刷新 lease 已被其它 worker 接管', {
      code: 'dynamic_render_lease_lost',
      content_id: contentId,
    });
  }
}
