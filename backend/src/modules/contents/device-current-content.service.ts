import { Injectable, Logger } from '@nestjs/common';
import type { ContentKind } from '@prisma/client';
import type { ContentSummaryT } from 'shared';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { formatError } from '../../common/utils/error-format';
import { DynamicContentRendererService } from '../dynamic-content/dynamic-content-renderer.service';
import { GroupsService } from '../groups/groups.service';
import type { DevicePollSnapshot } from '../devices/device-types';
import {
  contentToSummary,
  manifestReadEtag,
  type ContentReadProfileTarget,
} from './content-presenter';
import { CONTENT_SELECT, type ContentSelectRow } from './content-select';
import { ContentReadTargetResolver } from './content-read-target-resolver';

export interface CurrentContentRequest {
  deviceId: string;
  groupId: string;
  seq: number;
  contentId: string;
  manifestEtag: string;
  content: ContentSelectRow;
  readTarget: ContentReadProfileTarget;
}

@Injectable()
export class DeviceCurrentContentService {
  private readonly logger = new Logger(DeviceCurrentContentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dynamicRenderer: DynamicContentRendererService,
    private readonly readTargets: ContentReadTargetResolver,
    private readonly groups: GroupsService
  ) {}

  async resolveCurrentContentRequest(
    deviceOrId: string,
    telemetry:
      | {
          current_group?: string | null;
          current_content_seq?: number;
          manifest_etag?: string;
        }
      | undefined
  ): Promise<CurrentContentRequest | null>;
  async resolveCurrentContentRequest(
    deviceOrId: DevicePollSnapshot,
    telemetry:
      | {
          current_group?: string | null;
          current_content_seq?: number;
          manifest_etag?: string;
        }
      | undefined
  ): Promise<CurrentContentRequest | null>;
  async resolveCurrentContentRequest(
    deviceOrId: string | DevicePollSnapshot,
    telemetry:
      | {
          current_group?: string | null;
          current_content_seq?: number;
          manifest_etag?: string;
        }
      | undefined
  ): Promise<CurrentContentRequest | null> {
    const seq = telemetry?.current_content_seq;
    if (seq === undefined || !Number.isInteger(seq) || seq < 0) return null;
    const device =
      typeof deviceOrId === 'string'
        ? await this.prisma.device.findUnique({
            where: { id: deviceOrId },
            select: {
              id: true,
              selectedGroupId: true,
              selectedGroup: { select: { manifestEtag: true } },
              boardId: true,
              displayProfileId: true,
              protocolVersion: true,
            },
          })
        : deviceOrId;
    const groupId = device?.selectedGroupId;
    if (!groupId) return null;
    if (telemetry?.current_group && telemetry.current_group !== groupId) return null;
    const manifestEtag = await this.manifestEtagForDeviceGroup(device, groupId);
    if (!telemetry?.manifest_etag || telemetry.manifest_etag !== manifestEtag) return null;
    const content = await this.prisma.content.findUnique({
      where: { groupId_sortOrder: { groupId, sortOrder: seq } },
      select: CONTENT_SELECT,
    });
    if (!content) return null;
    return {
      deviceId: device.id,
      groupId,
      seq,
      contentId: content.id,
      manifestEtag: telemetry.manifest_etag,
      content,
      readTarget: this.readTargets.resolveSnapshot(device),
    };
  }

  currentContentForDevice(request: CurrentContentRequest): ContentSummaryT | null {
    const content = request.content;
    if (!content || content.groupId !== request.groupId || content.sortOrder !== request.seq) {
      return null;
    }
    const summary = contentToSummary(content, request.readTarget);
    if (summary.variant_status !== 'ready') return null;
    return summary;
  }

  async refreshCurrentContentForDeviceIfDue(
    request: CurrentContentRequest | null,
    deviceSnapshot?: DevicePollSnapshot
  ): Promise<CurrentContentRequest | null> {
    if (!request) return null;
    const device =
      deviceSnapshot ??
      (await this.prisma.device.findUnique({
        where: { id: request.deviceId },
        select: {
          id: true,
          selectedGroupId: true,
          selectedGroup: { select: { manifestEtag: true } },
          boardId: true,
          displayProfileId: true,
          protocolVersion: true,
        },
      }));
    const currentManifestEtag = device
      ? await this.manifestEtagForDeviceGroup(device, request.groupId)
      : null;
    if (
      !device ||
      device.selectedGroupId !== request.groupId ||
      currentManifestEtag !== request.manifestEtag
    ) {
      return null;
    }
    const content = request.content;
    if (!content || content.groupId !== request.groupId || content.sortOrder !== request.seq) {
      return null;
    }
    if (isCurrentDynamicDue(content)) {
      try {
        await this.dynamicRenderer.renderDynamicContent(content.id);
        const updatedContent = await this.prisma.content.findUnique({
          where: { id: request.contentId },
          select: CONTENT_SELECT,
        });
        if (
          !updatedContent ||
          updatedContent.groupId !== request.groupId ||
          updatedContent.sortOrder !== request.seq
        ) {
          return null;
        }
        return {
          ...request,
          manifestEtag: await this.manifestEtagForDeviceGroup(device, request.groupId),
          content: updatedContent,
          readTarget: this.readTargets.resolveSnapshot(device),
        };
      } catch (err) {
        this.logger.warn(
          `Dynamic current-frame refresh failed for content ${content.id} on device ${request.deviceId}: ${formatError(err)}`
        );
      }
    }
    return request;
  }

  async manifestEtagForDeviceGroup(
    device: Pick<DevicePollSnapshot, 'boardId' | 'displayProfileId' | 'protocolVersion'>,
    groupId: string
  ): Promise<string> {
    const readTarget = this.readTargets.resolveSnapshot(device);
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      select: {
        id: true,
        ownerUserId: true,
        name: true,
        sortOrder: true,
        structureEtag: true,
        contents: {
          orderBy: { sortOrder: 'asc' },
          select: CONTENT_SELECT,
        },
      },
    });
    if (!group) return '';
    const position =
      group.ownerUserId === null
        ? { current: 1, total: 1 }
        : await this.groups.ownerGroupPosition(group.ownerUserId, group.sortOrder);
    const contents = group.contents
      .map((content) => contentToSummary(content, readTarget))
      .filter((content) => content.variant_status === 'ready');
    return manifestReadEtag({
      profileId: readTarget.profile.id,
      group: {
        id: group.id,
        name: group.name,
        sort_order: group.sortOrder,
        position,
      },
      groupStructureEtag: group.structureEtag,
      contents,
    });
  }
}

function isCurrentDynamicDue(content: {
  kind: ContentKind;
  dynamicType: string | null;
  dynamicNextRunAt?: Date | null;
  dynamicRefreshDueAt?: Date | null;
}): boolean {
  if (content.kind !== 'dynamic' || !content.dynamicType) return false;
  const dueAt = content.dynamicRefreshDueAt ?? content.dynamicNextRunAt ?? null;
  return dueAt !== null && dueAt.getTime() <= Date.now();
}
