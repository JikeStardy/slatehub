import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  DEFAULT_DISPLAY_PROFILE_ID,
  frameDescriptorForProfile,
  type ContentDetailT,
  type ManifestResponseT,
} from 'shared';
import { BlobService } from '../../infra/blob/blob.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { InternalError, NotFoundError, ValidationError } from '../../common/errors';
import { computeETag } from '../../common/utils/etag';
import { GroupsService } from '../groups/groups.service';
import { ContentAudioBlobService } from './content-audio-blob.service';
import {
  contentFrameResourceEtag,
  contentToDetail,
  contentToSummary,
  manifestReadEtag,
  validateReadyVariantForProfile,
  type ContentReadProfileTarget,
} from './content-presenter';
import { ContentReadTargetResolver, type ContentReadScope } from './content-read-target-resolver';
import { CONTENT_SELECT, contentSelect } from './content-select';

@Injectable()
export class ContentsReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly groups: GroupsService,
    private readonly audioBlobs: ContentAudioBlobService,
    private readonly readTargets: ContentReadTargetResolver
  ) {}

  async assertReadable(gid: string, scope: ContentReadScope): Promise<void> {
    if (scope.deviceId !== undefined && scope.userId === undefined) {
      const device = await this.prisma.device.findUnique({
        where: { id: scope.deviceId },
        select: {
          ownerUserId: true,
          selectedGroup: { select: { id: true, ownerUserId: true } },
        },
      });
      if (
        !device?.selectedGroup ||
        device.selectedGroup.id !== gid ||
        device.ownerUserId !== device.selectedGroup.ownerUserId
      ) {
        throw new NotFoundError('相册不存在');
      }
      return;
    }

    const group = await this.prisma.group.findUnique({
      where: { id: gid },
      select: { ownerUserId: true },
    });
    if (!group) throw new NotFoundError('相册不存在');
    if (scope.userId !== undefined) {
      if (group.ownerUserId !== scope.userId) throw new NotFoundError('相册不存在');
      return;
    }
    throw new NotFoundError('相册不存在');
  }

  async manifest(
    gid: string,
    scope: ContentReadScope
  ): Promise<ManifestResponseT & { manifestEtag: string }> {
    const target = await this.resolveReadTarget(scope);
    await this.assertReadable(gid, scope);
    const group = await this.prisma.group.findUnique({
      where: { id: gid },
      include: {
        contents: {
          orderBy: { sortOrder: 'asc' },
          select: CONTENT_SELECT,
        },
      },
    });
    if (!group) throw new NotFoundError('相册不存在');

    const position =
      group.ownerUserId === null
        ? { current: 1, total: 1 }
        : await this.groups.ownerGroupPosition(group.ownerUserId, group.sortOrder);

    const contents = group.contents
      .map((content) => contentToSummary(content, target))
      .filter((content) => !target.device || content.variant_status === 'ready');
    const manifestEtag = manifestReadEtag({
      profileId: target.profile.id,
      group: {
        id: group.id,
        name: group.name,
        sort_order: group.sortOrder,
        position,
      },
      groupStructureEtag: group.structureEtag,
      contents,
    });
    return {
      group: {
        id: group.id,
        structure_etag: group.structureEtag,
        manifest_etag: manifestEtag,
        name: group.name,
        sort_order: group.sortOrder,
        position,
      },
      display_profile: target.profile,
      contents,
      manifestEtag,
    };
  }

  async list(gid: string, scope: ContentReadScope): Promise<ContentDetailT[]> {
    const target = await this.resolveReadTarget(scope);
    await this.assertReadable(gid, scope);
    const rows = await this.prisma.content.findMany({
      where: { groupId: gid },
      orderBy: { sortOrder: 'asc' },
      select: contentSelect({ dynamicLastError: true, audioText: true }),
    });
    return rows.map((row) => contentToDetail(row, target));
  }

  async get(contentId: string, scope: ContentReadScope): Promise<ContentDetailT> {
    const target = await this.resolveReadTarget(scope);
    const content = await this.requireReadableContent(
      contentId,
      scope,
      contentSelect({ dynamicLastError: true, audioText: true })
    );
    return contentToDetail(content, target);
  }

  async readImage(
    contentId: string,
    scope: ContentReadScope
  ): Promise<{ data: Buffer; etag: string }> {
    const target = await this.resolveReadTarget(scope);
    const content = await this.requireReadableContent(contentId, scope, {
      id: true,
      groupId: true,
      variants: {
        select: {
          profileId: true,
          status: true,
          pixelFormat: true,
          frameCodec: true,
          width: true,
          height: true,
          frameEtag: true,
          frameSize: true,
          storageKey: true,
          lastError: true,
        },
      },
    });
    const variant = content.variants.find((v) => v.profileId === target.profile.id);
    if (!variant || variant.status !== 'ready') throw new NotFoundError('该内容没有可用帧');
    const descriptor = frameDescriptorForProfile(target.profile.id);
    try {
      validateReadyVariantForProfile(variant, descriptor);
    } catch (err) {
      throw new InternalError('内容帧元数据损坏', { cause: String(err) });
    }
    this.validateStorageKey(variant.storageKey!, content.groupId, content.id, target.profile.id);
    const data = await this.blob.readStorageKey(variant.storageKey!);
    if (!data) throw new NotFoundError('图片文件丢失');
    if (data.byteLength !== variant.frameSize) {
      throw new InternalError('内容帧文件大小与元数据不一致');
    }
    if (computeETag(data) !== variant.frameEtag) {
      throw new InternalError('内容帧文件摘要与元数据不一致');
    }
    return { data, etag: contentFrameResourceEtag(target.profile.id, variant.frameEtag!) };
  }

  async readAudio(
    contentId: string,
    scope: ContentReadScope
  ): Promise<{ data: Buffer; etag: string }> {
    const content = await this.requireReadableContent(contentId, scope, {
      id: true,
      groupId: true,
      audioEtag: true,
      audioSize: true,
      audioStatus: true,
      audioSource: true,
      audioText: true,
      audioVoice: true,
    });
    if (!content.audioEtag || !content.audioSize) throw new NotFoundError('该内容没有音频');
    const data = await this.audioBlobs.read(content.groupId, content.id, content.audioEtag);
    if (!data) {
      throw new NotFoundError('音频文件丢失');
    }
    return { data, etag: content.audioEtag };
  }

  private async requireReadableContent<T extends Prisma.ContentSelect>(
    contentId: string,
    scope: ContentReadScope,
    select: T & { groupId: true }
  ): Promise<Prisma.ContentGetPayload<{ select: T }> & { groupId: string }> {
    const content = await this.prisma.content.findUnique({
      where: { id: contentId },
      select,
    });
    if (!content) throw new NotFoundError('内容不存在');
    const row = content as Prisma.ContentGetPayload<{ select: T }> & { groupId: string };
    await this.assertReadable(row.groupId, scope);
    return row;
  }

  private async resolveReadTarget(scope: ContentReadScope): Promise<ContentReadProfileTarget> {
    try {
      return await this.readTargets.resolve(scope);
    } catch (err) {
      if (err instanceof ValidationError || err instanceof NotFoundError) throw err;
      if (scope.displayProfileId !== undefined) {
        throw new ValidationError('未知 display_profile_id', {
          display_profile_id: scope.displayProfileId,
        });
      }
      throw err;
    }
  }

  private validateStorageKey(
    storageKey: string,
    groupId: string,
    contentId: string,
    profileId: string
  ): void {
    const canonical = this.blob.frameKey(groupId, contentId, profileId);
    const migratedNote4Legacy =
      profileId === DEFAULT_DISPLAY_PROFILE_ID && storageKey === `${groupId}/${contentId}.img`;
    if (storageKey !== canonical && !migratedNote4Legacy) {
      throw new InternalError('内容帧存储键与请求目标不一致');
    }
  }
}
