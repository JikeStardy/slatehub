import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  DEFAULT_DISPLAY_PROFILE_ID,
  getDisplayProfile,
  type ContentDetailT,
  type ManifestResponseT,
} from 'shared';
import { BlobService } from '../../infra/blob/blob.service';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { NotFoundError } from '../../common/errors';
import { GroupsService } from '../groups/groups.service';
import { ContentAudioBlobService } from './content-audio-blob.service';
import { contentToDetail, contentToSummary } from './content-presenter';
import { CONTENT_SELECT, contentSelect } from './content-select';

@Injectable()
export class ContentsReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly groups: GroupsService,
    private readonly audioBlobs: ContentAudioBlobService
  ) {}

  async assertReadable(gid: string, scope: { userId?: string; deviceId?: string }): Promise<void> {
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
    scope: { userId?: string; deviceId?: string }
  ): Promise<ManifestResponseT & { manifestEtag: string }> {
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

    return {
      group: {
        id: group.id,
        structure_etag: group.structureEtag,
        manifest_etag: group.manifestEtag,
        name: group.name,
        sort_order: group.sortOrder,
        position,
      },
      display_profile: getDisplayProfile(DEFAULT_DISPLAY_PROFILE_ID),
      contents: group.contents.map((content) => contentToSummary(content)),
      manifestEtag: group.manifestEtag,
    };
  }

  async list(
    gid: string,
    scope: { userId?: string; deviceId?: string }
  ): Promise<ContentDetailT[]> {
    await this.assertReadable(gid, scope);
    const rows = await this.prisma.content.findMany({
      where: { groupId: gid },
      orderBy: { sortOrder: 'asc' },
      select: contentSelect({ dynamicLastError: true, audioText: true }),
    });
    return rows.map((row) => contentToDetail(row));
  }

  async get(
    contentId: string,
    scope: { userId?: string; deviceId?: string }
  ): Promise<ContentDetailT> {
    const content = await this.requireReadableContent(
      contentId,
      scope,
      contentSelect({ dynamicLastError: true, audioText: true })
    );
    return contentToDetail(content);
  }

  async readImage(
    contentId: string,
    scope: { userId?: string; deviceId?: string }
  ): Promise<{ data: Buffer; etag: string }> {
    const content = await this.requireReadableContent(contentId, scope, {
      id: true,
      groupId: true,
      imageEtag: true,
    });
    const data = await this.blob.read(content.groupId, content.id, 'image');
    if (!data) throw new NotFoundError('图片文件丢失');
    return { data, etag: content.imageEtag };
  }

  async readAudio(
    contentId: string,
    scope: { userId?: string; deviceId?: string }
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
      await this.audioBlobs.repairMissingAudioBlob(content);
      throw new NotFoundError('音频文件丢失');
    }
    return { data, etag: content.audioEtag };
  }

  private async requireReadableContent<T extends Prisma.ContentSelect>(
    contentId: string,
    scope: { userId?: string; deviceId?: string },
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
}
