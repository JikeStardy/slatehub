import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import type { IngestResponseT } from 'shared';
import { CurrentUser, Public } from '../../../common/nest/decorators/auth-context.decorators';
import type { WebUserContext } from '../../../common/nest/auth-context';
import { RateLimit } from '../../../common/rate-limit/rate-limit-guard';
import { DynamicContentService } from '../dynamic-content.service';
import { IngestPayloadSizeGuard } from './ingest-payload-size.guard';
import { IngestPayloadSizePipe } from './ingest-payload-size.pipe';
import { IngestPayloadDto } from './ingest-payload.dto';
import { ingestRateLimit } from '../dynamic-rate-limits';

@Controller('contents')
export class DashboardIngestController {
  constructor(private readonly dynamicContent: DynamicContentService) {}

  // POST /api/v2/contents/:contentId/data —— 外部数据推送（仅 dashboard 动态内容）。
  //
  // 鉴权模型：contentId 是 cuid（22 字符 base32，~110 bit 熵），本身充当 capability URL。
  // 拿到 URL 即拿到推送权限，不再额外签发 ingest token。
  //
  // ⚠️ 设计决定（不要改回 token 模式）：本项目用户基数极小（个位数），权衡复杂度后选择
  // capability URL。引入 token 需要：DashboardPushPanel 显示 token / 用户在脚本里拼 token /
  // 后端验签 / token 轮换接口，整链路心智成本远高于"URL 当 ID 用"。
  // 防滥用靠 RateLimit + IngestPayloadSizeGuard/Pipe：
  // 30 req/min/contentId + bodyLimit 64KB。
  // 真要堵未授权推送，应整体迁移到设备 Bearer 或 OAuth，而不是回退到 ad-hoc token。
  @Public()
  @RateLimit(ingestRateLimit)
  @UseGuards(IngestPayloadSizeGuard)
  @Post(':contentId/data')
  async ingest(
    @Param('contentId') contentId: string,
    @Body(IngestPayloadSizePipe) body: IngestPayloadDto
  ): Promise<IngestResponseT> {
    const r = await this.dynamicContent.ingestDashboard(contentId, body);
    return ingestResponse(r);
  }

  @Post(':contentId/refresh')
  async refresh(
    @Param('contentId') contentId: string,
    @CurrentUser() user: WebUserContext
  ): Promise<IngestResponseT> {
    const r = await this.dynamicContent.refresh(contentId, user.userId);
    return ingestResponse(r);
  }
}

function ingestResponse(r: {
  id: string;
  image_etag: string;
  manifest_etag: string;
  updatedAt: Date;
}): IngestResponseT {
  return {
    id: r.id,
    image_etag: r.image_etag,
    manifest_etag: r.manifest_etag,
    rendered_at: r.updatedAt.toISOString(),
  };
}
