import { Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type ContentDetailT, type ManifestResponseT } from 'shared';
import type { DeviceContext, WebUserContext } from '../../common/nest/auth-context';
import {
  CurrentDevice,
  CurrentUser,
  Public,
} from '../../common/nest/decorators/auth-context.decorators';
import { JwtOrDeviceAuthGuard } from '../../common/nest/guards/jwt-or-device-auth.guard';
import { respondJsonWithEtag, respondWithEtag } from '../../common/utils/etag';
import { contentAuthScope } from './content-controller-helpers';
import { ContentsReadService } from './contents-read.service';

@Controller()
export class ContentsReadController {
  constructor(private readonly reads: ContentsReadService) {}

  @Public()
  @UseGuards(JwtOrDeviceAuthGuard)
  @Get('groups/:groupId/manifest')
  async manifest(
    @Param('groupId') groupId: string,
    @Query('display_profile_id') displayProfileId: string | undefined,
    @CurrentUser() user: WebUserContext | undefined,
    @CurrentDevice() device: DeviceContext | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply
  ): Promise<void> {
    const m = await this.reads.manifest(groupId, contentAuthScope(user, device, displayProfileId));
    const body: ManifestResponseT = {
      group: m.group,
      display_profile: m.display_profile,
      contents: m.contents,
    };
    respondJsonWithEtag(req, reply, m.manifestEtag, body);
  }

  @Public()
  @UseGuards(JwtOrDeviceAuthGuard)
  @Get('groups/:groupId/contents')
  list(
    @Param('groupId') groupId: string,
    @Query('display_profile_id') displayProfileId: string | undefined,
    @CurrentUser() user: WebUserContext | undefined,
    @CurrentDevice() device: DeviceContext | undefined
  ): Promise<ContentDetailT[]> {
    return this.reads.list(groupId, contentAuthScope(user, device, displayProfileId));
  }

  @Public()
  @UseGuards(JwtOrDeviceAuthGuard)
  @Get('contents/:contentId')
  getOne(
    @Param('contentId') contentId: string,
    @Query('display_profile_id') displayProfileId: string | undefined,
    @CurrentUser() user: WebUserContext | undefined,
    @CurrentDevice() device: DeviceContext | undefined
  ): Promise<ContentDetailT> {
    return this.reads.get(contentId, contentAuthScope(user, device, displayProfileId));
  }

  @Public()
  @UseGuards(JwtOrDeviceAuthGuard)
  @Get('contents/:contentId/image')
  async image(
    @Param('contentId') contentId: string,
    @Query('display_profile_id') displayProfileId: string | undefined,
    @CurrentUser() user: WebUserContext | undefined,
    @CurrentDevice() device: DeviceContext | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply
  ): Promise<void> {
    const r = await this.reads.readImage(
      contentId,
      contentAuthScope(user, device, displayProfileId)
    );
    respondWithEtag(req, reply, r.etag, r.data, 'application/octet-stream');
  }

  @Public()
  @UseGuards(JwtOrDeviceAuthGuard)
  @Get('contents/:contentId/audio')
  async audio(
    @Param('contentId') contentId: string,
    @CurrentUser() user: WebUserContext | undefined,
    @CurrentDevice() device: DeviceContext | undefined,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply
  ): Promise<void> {
    const r = await this.reads.readAudio(contentId, contentAuthScope(user, device));
    respondWithEtag(req, reply, r.etag, r.data, 'application/octet-stream');
  }
}
