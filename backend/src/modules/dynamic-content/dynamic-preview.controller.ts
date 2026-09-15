import { Body, Controller, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CurrentUser } from '../../common/nest/decorators/auth-context.decorators';
import type { WebUserContext } from '../../common/nest/auth-context';
import { PreviewDynamicContentDto } from './dto/preview-dynamic-content.dto';
import { DynamicContentService } from './dynamic-content.service';

@Controller()
export class DynamicPreviewController {
  constructor(private readonly dynamicContent: DynamicContentService) {}

  @Post('contents/preview')
  async previewDynamicDirect(
    @Body() body: PreviewDynamicContentDto,
    @Res() reply: FastifyReply
  ): Promise<void> {
    const data = await this.dynamicContent.previewDirect(body);
    void reply.header('Cache-Control', 'no-store').type('application/octet-stream').send(data);
  }

  @Post('contents/:contentId/preview')
  async previewDynamic(
    @Param('contentId') contentId: string,
    @CurrentUser() user: WebUserContext,
    @Body() body: PreviewDynamicContentDto,
    @Res() reply: FastifyReply
  ): Promise<void> {
    const data = await this.dynamicContent.preview(contentId, user.userId, {
      config: body.config,
      display_profile_id: body.display_profile_id,
      frame_name: body.frame_name,
      data: body.data,
    });
    void reply.header('Cache-Control', 'no-store').type('application/octet-stream').send(data);
  }
}
