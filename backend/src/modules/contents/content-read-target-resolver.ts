import { Injectable } from '@nestjs/common';
import {
  DEFAULT_DISPLAY_PROFILE_ID,
  BOARD_DEFINITIONS,
  displayProfilesForEnvironment,
  getBoardDefinition,
  getDisplayProfile,
  type DisplayProfileT,
} from 'shared';
import { ValidationError, NotFoundError } from '../../common/errors';
import { AppConfig } from '../../infra/config/app.config';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { ContentReadProfileTarget } from './content-presenter';

export interface ContentReadScope {
  userId?: string;
  deviceId?: string;
  displayProfileId?: string;
}

export const CURRENT_DEVICE_PROTOCOL_VERSION = 2;

@Injectable()
export class ContentReadTargetResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig
  ) {}

  async resolve(scope: ContentReadScope): Promise<ContentReadProfileTarget> {
    if (scope.deviceId !== undefined) return this.resolveDeviceTarget(scope);
    return this.resolveWebTarget(scope.displayProfileId);
  }

  resolveSnapshot(device: {
    boardId: string;
    displayProfileId: string;
    protocolVersion: number;
  }): ContentReadProfileTarget {
    return this.deviceTargetFromPersisted(device);
  }

  private async resolveDeviceTarget(scope: ContentReadScope): Promise<ContentReadProfileTarget> {
    const device = await this.prisma.device.findUnique({
      where: { id: scope.deviceId },
      select: {
        boardId: true,
        displayProfileId: true,
        protocolVersion: true,
      },
    });
    if (!device) throw new NotFoundError('设备不存在');
    if (
      scope.displayProfileId !== undefined &&
      scope.displayProfileId !== device.displayProfileId
    ) {
      throw new ValidationError('设备不能覆盖已注册的显示配置', {
        requested_display_profile_id: scope.displayProfileId,
        device_display_profile_id: device.displayProfileId,
      });
    }
    return this.deviceTargetFromPersisted(device);
  }

  private deviceTargetFromPersisted(device: {
    boardId: string;
    displayProfileId: string;
    protocolVersion: number;
  }): ContentReadProfileTarget {
    if (device.protocolVersion !== CURRENT_DEVICE_PROTOCOL_VERSION) {
      throw new ValidationError('设备协议版本不受支持', {
        protocol_version: device.protocolVersion,
        supported_protocol_version: CURRENT_DEVICE_PROTOCOL_VERSION,
      });
    }
    const board = safeBoard(device.boardId);
    if (board.display_profile_id !== device.displayProfileId) {
      throw new ValidationError('设备显示配置与硬件板卡不匹配', {
        board_id: device.boardId,
        board_display_profile_id: board.display_profile_id,
        device_display_profile_id: device.displayProfileId,
      });
    }
    return {
      profile: getDisplayProfile(device.displayProfileId),
      audio: board.capabilities.audio,
      device: true,
    };
  }

  private resolveWebTarget(displayProfileId: string | undefined): ContentReadProfileTarget {
    const profile = getDisplayProfile(displayProfileId ?? DEFAULT_DISPLAY_PROFILE_ID);
    if (!displayProfilesForEnvironment(this.config.nodeEnv).some((p) => p.id === profile.id)) {
      throw new ValidationError('当前环境不可使用该 display_profile_id', {
        display_profile_id: profile.id,
        node_env: this.config.nodeEnv,
      });
    }
    const board = boardForDisplayProfile(profile);
    return {
      profile,
      audio: board?.capabilities.audio ?? false,
      device: false,
    };
  }
}

function safeBoard(boardId: string) {
  try {
    return getBoardDefinition(boardId);
  } catch (err) {
    throw new ValidationError('未知设备板卡', {
      board_id: boardId,
      cause: String(err),
    });
  }
}

function boardForDisplayProfile(profile: DisplayProfileT) {
  return BOARD_DEFINITIONS.find((board) => board.display_profile_id === profile.id);
}
