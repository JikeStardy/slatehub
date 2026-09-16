import { createId } from '@paralleldrive/cuid2';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DashboardDataPayload,
  displayProfilesForEnvironment,
  DynamicConfig,
  getDisplayProfile,
  isAudioDynamicConfig,
  type ContentMutationResponseT,
  type CreateDynamicContentRequestT,
  type IngestPayloadT,
} from 'shared';
import { BlobService } from '../../infra/blob/blob.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { computeETag } from '../../common/utils/etag';
import { ConflictError, InternalError, NotFoundError, ValidationError } from '../../common/errors';
import { toPrismaInputJson } from '../../common/db/prisma-json';
import { lockGroupRow } from '../../common/db/row-locks';
import { compactContentSortOrders } from '../../common/db/bulk-sort-order';
import { nextContentSortOrder } from '../../common/db/sort-order';
import { formatError } from '../../common/utils/error-format';
import { ContentMutationCoordinator } from '../../common/worker/content-mutation-coordinator';
import { AppConfig } from '../../infra/config/app.config';
import { GroupsService } from '../groups/groups.service';
import { deleteContentAudioBlob } from '../../infra/blob/content-audio-blobs';
import { DynamicContentRegistry } from './dynamic-content-registry';
import { DynamicContentRendererService } from './dynamic-content-renderer.service';
import { defaultDynamicFrameName } from './status-text/dynamic-content-status-text';
import { toContentMutationResponse } from '../contents/content-mutation-response';

@Injectable()
export class DynamicContentService {
  private readonly logger = new Logger(DynamicContentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly groups: GroupsService,
    private readonly registry: DynamicContentRegistry,
    private readonly renderer: DynamicContentRendererService,
    private readonly contentMutations: ContentMutationCoordinator = ContentMutationCoordinator.default(),
    private readonly config: AppConfig = { nodeEnv: 'test' } as AppConfig
  ) {}

  async previewDirect(raw: {
    config: unknown;
    display_profile_id: string;
    frame_name?: string | null;
    data?: unknown;
  }): Promise<Buffer> {
    const config = DynamicConfig.parse(raw.config);
    const previewData = this.parseDashboardPreviewData(config.type, raw.data);
    const displayProfileId = this.resolvePreviewDisplayProfile(raw.display_profile_id);
    return this.renderer.renderPreviewDirect(
      config.type,
      config,
      raw.frame_name ?? defaultDynamicFrameName(config.type, config),
      previewData,
      displayProfileId
    );
  }

  async preview(
    contentId: string,
    ownerUserId: string,
    body: {
      config: unknown;
      display_profile_id: string;
      frame_name?: string | null;
      data?: unknown;
    }
  ): Promise<Buffer> {
    const displayProfileId = this.resolvePreviewDisplayProfile(body.display_profile_id);
    if (body.data === undefined) {
      return this.renderer.renderPreview(
        contentId,
        ownerUserId,
        body.config,
        body.frame_name,
        displayProfileId
      );
    }

    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: {
        kind: true,
        dynamicType: true,
        frameName: true,
        group: { select: { ownerUserId: true } },
      },
    });
    if (!content || content.group.ownerUserId !== ownerUserId)
      throw new NotFoundError('内容不存在');
    if (content.kind !== 'dynamic' || !content.dynamicType)
      throw new ValidationError('该内容不是动态类型');
    const config = DynamicConfig.parse(body.config);
    if (config.type !== content.dynamicType) {
      throw new ValidationError(
        `dynamic_type 与 config.type 不一致: ${content.dynamicType} vs ${config.type}`
      );
    }
    if (config.type !== 'dashboard') {
      throw new ValidationError('只有外部数据预览支持 data 参数');
    }
    const frameName = body.frame_name === undefined ? content.frameName : body.frame_name;
    const previewData = this.parseDashboardData(body.data, 'dashboard 预览数据不能为空');
    return this.renderer.renderPreviewDirect(
      config.type,
      config,
      frameName,
      previewData,
      displayProfileId
    );
  }

  private resolvePreviewDisplayProfile(displayProfileId: string): string {
    const profile = getDisplayProfile(displayProfileId);
    if (!displayProfilesForEnvironment(this.config.nodeEnv).some((p) => p.id === profile.id)) {
      throw new ValidationError('当前环境不可使用该 display_profile_id', {
        display_profile_id: profile.id,
        node_env: this.config.nodeEnv,
      });
    }
    return profile.id;
  }

  async append(
    gid: string,
    ownerUserId: string,
    raw: CreateDynamicContentRequestT
  ): Promise<ContentMutationResponseT> {
    await this.groups.assertOwned(gid, ownerUserId);
    const contentId = createId();
    return this.runMutation(contentId, () => this.appendUnqueued(gid, raw, contentId));
  }

  private async appendUnqueued(
    gid: string,
    raw: CreateDynamicContentRequestT,
    contentId: string
  ): Promise<ContentMutationResponseT> {
    const { config, frame_name } = raw;
    const dynamicType = config.type;
    const entry = this.registry.get(dynamicType);
    if (!entry) throw new ValidationError(`未知动态类型: ${dynamicType}`);
    const validatedConfig = DynamicConfig.parse(config);
    if (validatedConfig.type !== dynamicType) {
      throw new ValidationError(
        `dynamic_type 与 config.type 不一致: ${dynamicType} vs ${validatedConfig.type}`
      );
    }
    const initialDashboardData =
      validatedConfig.type === 'dashboard'
        ? this.parseDashboardData(raw.initial_data, 'dashboard 初始数据不能为空')
        : undefined;

    const placeholderEtag = computeETag(`dynamic-init:${contentId}`);
    const audioEnabled = isAudioDynamicConfig(validatedConfig) && validatedConfig.audio_enabled;
    const audioVoice = isAudioDynamicConfig(validatedConfig) ? validatedConfig.audio_voice : null;
    let created: { seq: number; didCreate: boolean } = { seq: -1, didCreate: false };
    try {
      const seq = await this.prisma.$transaction(async (tx) => {
        await lockGroupRow(tx, gid);
        const nextSeq = await nextContentSortOrder(tx, gid);
        await tx.content.create({
          data: {
            id: contentId,
            groupId: gid,
            sortOrder: nextSeq,
            frameName: frame_name ?? defaultDynamicFrameName(dynamicType, validatedConfig),
            kind: 'dynamic',
            dynamicType,
            dynamicConfig: toPrismaInputJson(validatedConfig),
            ...(initialDashboardData === undefined
              ? {}
              : { dynamicData: toPrismaInputJson(initialDashboardData) }),
            imageEtag: placeholderEtag,
            imageSize: 0,
            audioStatus: audioEnabled ? 'pending' : 'none',
            audioSource: audioEnabled ? 'tts' : null,
            audioVoice: audioEnabled ? audioVoice : null,
            dynamicNextRunAt: new Date(0),
            dynamicRefreshDueAt: new Date(0),
          },
        });
        return nextSeq;
      });
      created = { seq, didCreate: true };
      const rendered = await this.renderDynamicAndReadEtag(contentId);
      return toContentMutationResponse(
        contentId,
        seq,
        rendered.imageEtag,
        null,
        rendered.groupEtag,
        rendered.contentEtag
      );
    } catch (err) {
      if (created.didCreate) await this.rollbackCreation(contentId, gid, err);
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
        throw new ConflictError('内容序号已存在');
      throw err;
    }
  }

  async patch(
    contentId: string,
    ownerUserId: string,
    body: { frame_name?: string | null; config?: unknown }
  ): Promise<ContentMutationResponseT> {
    if (body.frame_name === undefined && body.config === undefined) {
      throw new ValidationError('没有可更新的字段', { code: 'nothing_to_patch' });
    }

    return this.runMutation(contentId, async () => {
      const content = await this.prisma.content.findUnique({
        where: { id: contentId },
        select: {
          id: true,
          groupId: true,
          sortOrder: true,
          kind: true,
          dynamicType: true,
          dynamicConfig: true,
        },
      });
      if (!content) throw new NotFoundError('内容不存在');
      if (content.kind !== 'dynamic' || !content.dynamicType)
        throw new ValidationError('该内容不是动态类型');
      await this.groups.assertOwned(content.groupId, ownerUserId);

      const data: Prisma.ContentUpdateInput = {};
      if (body.frame_name !== undefined) data.frameName = body.frame_name;
      if (body.config !== undefined) {
        const validated = DynamicConfig.parse(body.config);
        const currentType = content.dynamicType;
        if (validated.type !== currentType) {
          throw new ValidationError(
            `不能在已有动态内容上改 type（${currentType} → ${validated.type}），请删除后重建`
          );
        }
        data.dynamicConfig = toPrismaInputJson(validated);
        data.dynamicRefreshDueAt = new Date();
        data.dynamicRefreshLeaseUntil = null;
        if (body.frame_name === undefined && currentType !== 'dashboard') {
          data.frameName = defaultDynamicFrameName(currentType, validated);
        }
      }
      await this.prisma.content.update({ where: { id: contentId }, data });
      const rendered = await this.renderDynamicAndReadEtag(contentId);
      return toContentMutationResponse(
        contentId,
        content.sortOrder,
        rendered.imageEtag,
        rendered.audioEtag,
        rendered.groupEtag,
        rendered.contentEtag
      );
    });
  }

  async patchFrameNameIfDynamic(
    contentId: string,
    ownerUserId: string,
    frameName: string | null
  ): Promise<ContentMutationResponseT | null> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: {
        groupId: true,
        sortOrder: true,
        kind: true,
        dynamicType: true,
        group: { select: { ownerUserId: true } },
      },
    });
    if (!content) throw new NotFoundError('内容不存在');
    if (content.group.ownerUserId !== ownerUserId) throw new NotFoundError('内容不存在');
    if (content.kind !== 'dynamic') return null;
    if (!content.dynamicType) throw new ValidationError('该内容不是动态类型');

    const rendered = await this.runMutation(contentId, async () => {
      await this.prisma.content.update({ where: { id: contentId }, data: { frameName } });
      return this.renderDynamicAndReadEtag(contentId);
    });
    return toContentMutationResponse(
      contentId,
      content.sortOrder,
      rendered.imageEtag,
      rendered.audioEtag,
      rendered.groupEtag,
      rendered.contentEtag
    );
  }

  async ingestDashboard(
    contentId: string,
    payload: IngestPayloadT
  ): Promise<ContentMutationResponseT & { updatedAt: Date }> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: {
        sortOrder: true,
        kind: true,
        dynamicType: true,
      },
    });
    if (!content || content.kind !== 'dynamic' || content.dynamicType !== 'dashboard') {
      throw new NotFoundError('dashboard 内容不存在');
    }
    const rendered = await this.renderDynamicAndReadEtag(contentId, {
      force: true,
      dataOverride: payload.data,
    });
    return {
      ...toContentMutationResponse(
        contentId,
        content.sortOrder,
        rendered.imageEtag,
        rendered.audioEtag,
        rendered.groupEtag,
        rendered.contentEtag
      ),
      updatedAt: rendered.renderedAt,
    };
  }

  async refresh(
    contentId: string,
    ownerUserId: string
  ): Promise<ContentMutationResponseT & { updatedAt: Date }> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select: {
        groupId: true,
        sortOrder: true,
        kind: true,
        dynamicType: true,
        group: { select: { ownerUserId: true } },
      },
    });
    if (!content) throw new NotFoundError('内容不存在');
    if (content.kind !== 'dynamic' || !content.dynamicType)
      throw new ValidationError('非动态内容不支持手动刷新');
    if (content.group.ownerUserId !== ownerUserId) throw new NotFoundError('内容不存在');
    const rendered = await this.renderDynamicAndReadEtag(contentId);
    return {
      ...toContentMutationResponse(
        contentId,
        content.sortOrder,
        rendered.imageEtag,
        rendered.audioEtag,
        rendered.groupEtag,
        rendered.contentEtag
      ),
      updatedAt: rendered.renderedAt,
    };
  }

  private parseDashboardPreviewData(dynamicType: string, rawData: unknown): unknown {
    if (dynamicType !== 'dashboard') return undefined;
    return this.parseDashboardData(rawData, 'dashboard 预览数据不能为空');
  }

  private parseDashboardData(rawData: unknown, message: string): Record<string, unknown> {
    const parsed = DashboardDataPayload.safeParse(rawData);
    if (!parsed.success) {
      throw new ValidationError(message, { issues: parsed.error.issues });
    }
    return parsed.data;
  }

  private renderDynamicAndReadEtag(
    contentId: string,
    opts: Parameters<DynamicContentRendererService['renderDynamicContent']>[1] = { force: true }
  ): ReturnType<DynamicContentRendererService['renderDynamicContent']> {
    return this.renderer.renderDynamicContent(contentId, opts);
  }

  private runMutation<T>(contentId: string, fn: () => Promise<T>): Promise<T> {
    return this.contentMutations.run(contentId, fn, { continueAfterFailure: true });
  }

  private async rollbackCreation(contentId: string, gid: string, err: unknown): Promise<void> {
    const stale = await this.prisma.content
      .findUnique({
        where: { id: contentId },
        select: { audioEtag: true },
      })
      .catch((staleErr: unknown) => {
        this.logger.warn(
          `Failed to read dynamic content rollback state for content ${contentId}: ${formatError(staleErr)}`
        );
        return null;
      });
    let rollbackOk = true;
    let rollbackError: string | null = null;
    await this.prisma
      .$transaction(async (tx) => {
        await lockGroupRow(tx, gid);
        await tx.content.delete({ where: { id: contentId } });
        await compactContentSortOrders(tx, gid);
        await this.groups.recomputeManifestEtag(gid, tx);
      })
      .catch((rollbackErr: unknown) => {
        rollbackOk = false;
        rollbackError = formatError(rollbackErr);
        this.logger.warn(
          `Database rollback failed after dynamic content creation failed for content ${contentId}: ${rollbackError}`
        );
      });
    if (!rollbackOk) {
      throw new InternalError('创建动态内容失败，且 DB 回滚未完成', {
        code: 'dynamic_create_rollback_failed',
        original_error: formatError(err),
        rollback_error: rollbackError,
      });
    }
    const cleaned = await Promise.allSettled([
      this.blob.delete(gid, contentId, 'image'),
      deleteContentAudioBlob(this.blob, gid, contentId, stale?.audioEtag ?? null),
    ]);
    const failed = cleaned.filter((result) => result.status === 'rejected').length;
    if (failed > 0) {
      this.logger.warn(
        `Blob cleanup failed after dynamic content creation failed for content ${contentId}: ${failed} operation(s) failed.`
      );
    }
  }
}
