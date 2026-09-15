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
  devicePlayableProjection,
  manifestReadEtag,
  type ContentReadProfileTarget,
} from './content-presenter';
import { contentSelectForProfile, type ContentSelectRow } from './content-select';
import { ContentReadTargetResolver } from './content-read-target-resolver';

export interface DeviceManifestSnapshot {
  groupId: string;
  manifestEtag: string;
  contentCount: number;
  contents: ContentSummaryT[];
  entries: Array<{ content: ContentSelectRow; summary: ContentSummaryT }>;
}

export interface CurrentContentRequest {
  deviceId: string;
  groupId: string;
  seq: number;
  contentId: string;
  manifestEtag: string;
  content: ContentSelectRow;
  readTarget: ContentReadProfileTarget;
  manifestSnapshot?: DeviceManifestSnapshot;
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
      | undefined,
    manifestSnapshot?: DeviceManifestSnapshot | null
  ): Promise<CurrentContentRequest | null>;
  async resolveCurrentContentRequest(
    deviceOrId: DevicePollSnapshot,
    telemetry:
      | {
          current_group?: string | null;
          current_content_seq?: number;
          manifest_etag?: string;
        }
      | undefined,
    manifestSnapshot?: DeviceManifestSnapshot | null
  ): Promise<CurrentContentRequest | null>;
  async resolveCurrentContentRequest(
    deviceOrId: string | DevicePollSnapshot,
    telemetry:
      | {
          current_group?: string | null;
          current_content_seq?: number;
          manifest_etag?: string;
        }
      | undefined,
    manifestSnapshot?: DeviceManifestSnapshot | null
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
    const snapshot =
      manifestSnapshot ?? (await this.manifestSnapshotForDeviceGroup(device, groupId));
    const manifestEtag = snapshot?.manifestEtag ?? '';
    if (!telemetry?.manifest_etag || telemetry.manifest_etag !== manifestEtag) return null;
    const entry = snapshot?.entries[seq];
    if (!entry) return null;
    return {
      deviceId: device.id,
      groupId,
      seq,
      contentId: entry.content.id,
      manifestEtag: telemetry.manifest_etag,
      content: entry.content,
      readTarget: this.readTargets.resolveSnapshot(device),
      manifestSnapshot: snapshot ?? undefined,
    };
  }

  currentContentForDevice(request: CurrentContentRequest): ContentSummaryT | null {
    const entry = request.manifestSnapshot?.entries[request.seq];
    if (entry) {
      if (entry.content.id !== request.contentId || entry.content.groupId !== request.groupId) {
        return null;
      }
      return entry.summary;
    }
    const content = request.content;
    if (!content || content.groupId !== request.groupId) return null;
    const summary = contentToSummary(content, request.readTarget);
    if (summary.variant_status !== 'ready') return null;
    return { ...summary, seq: request.seq };
  }

  async refreshCurrentContentForDeviceIfDue(
    request: CurrentContentRequest | null,
    deviceSnapshot?: DevicePollSnapshot,
    manifestSnapshot?: DeviceManifestSnapshot | null
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
    const snapshot =
      manifestSnapshot ??
      request.manifestSnapshot ??
      (device ? await this.manifestSnapshotForDeviceGroup(device, request.groupId) : null);
    if (
      !device ||
      device.selectedGroupId !== request.groupId ||
      snapshot?.manifestEtag !== request.manifestEtag
    ) {
      return null;
    }
    const content = request.content;
    if (!content || content.groupId !== request.groupId) return null;
    if (isCurrentDynamicDue(content)) {
      try {
        await this.dynamicRenderer.renderDynamicContent(content.id);
        const updatedSnapshot = await this.manifestSnapshotForDeviceGroup(device, request.groupId);
        const updatedEntry = updatedSnapshot?.entries.find(
          (entry) => entry.content.id === request.contentId
        );
        if (!updatedSnapshot || !updatedEntry) return null;
        return {
          ...request,
          seq: updatedEntry.summary.seq,
          manifestEtag: updatedSnapshot.manifestEtag,
          contentId: updatedEntry.content.id,
          content: updatedEntry.content,
          readTarget: this.readTargets.resolveSnapshot(device),
          manifestSnapshot: updatedSnapshot,
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
    return (await this.manifestSnapshotForDeviceGroup(device, groupId))?.manifestEtag ?? '';
  }

  async manifestSnapshotForDeviceGroup(
    device: Pick<DevicePollSnapshot, 'boardId' | 'displayProfileId' | 'protocolVersion'>,
    groupId: string
  ): Promise<DeviceManifestSnapshot | null> {
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
          select: contentSelectForProfile(readTarget.profile.id),
        },
      },
    });
    if (!group) return null;
    const position =
      group.ownerUserId === null
        ? { current: 1, total: 1 }
        : await this.groups.ownerGroupPosition(group.ownerUserId, group.sortOrder);
    const entries = devicePlayableProjection(group.contents, readTarget) as Array<{
      content: ContentSelectRow;
      summary: ContentSummaryT;
    }>;
    const contents = entries.map((entry) => entry.summary);
    const manifestEtag = manifestReadEtag({
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
    return {
      groupId: group.id,
      manifestEtag,
      contentCount: contents.length,
      contents,
      entries,
    };
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
