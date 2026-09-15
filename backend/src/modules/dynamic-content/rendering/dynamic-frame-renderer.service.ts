import { Injectable } from '@nestjs/common';
import { BitmapCanvas, PIXEL_BLACK, PIXEL_WHITE } from './bitmap-canvas';
import {
  renderDailyCalendarFrame,
  renderHistoryTodayFrame,
  renderMonthCalendarFrame,
} from './calendar-frame-renderer';
import { buildCompactFrameModel } from './compact-frame-model';
import { renderDashboardFrame } from './dashboard-frame-renderer';
import type { DynamicRenderContext } from './dynamic-render-context';
import { renderEarthquakeReportFrame } from './earthquake-frame-renderer';
import { FrameDrawKit } from './frame-draw-kit';
import { STATUS_BAR_H } from './frame-renderer-layout';
import { DynamicFrameFontService, type FontSet } from './fonts/dynamic-frame-font.service';
import { renderFontTestFrame } from './font-test-frame-renderer';
import { renderHotListFrame } from './hot-list-frame-renderer';
import { encodeMonoFrame, type RenderTarget } from '../../rendering/render-target';
import { renderWeatherAlertFrame, renderWeatherFrame } from './weather-frame-renderer';

export type { DynamicRenderContext } from './dynamic-render-context';

@Injectable()
export class DynamicFrameRendererService {
  private readonly drawKit: FrameDrawKit;

  constructor(private readonly fontService: DynamicFrameFontService) {
    this.drawKit = new FrameDrawKit(fontService);
  }

  async render(ctx: DynamicRenderContext, target: RenderTarget): Promise<Buffer> {
    const fonts = await this.fontService.getFonts();
    const c = new BitmapCanvas(target.width, target.height);
    c.clear(PIXEL_WHITE);
    this.clearSystemStatusArea(c, target);

    if (target.layoutFamily === 'compact') {
      this.renderCompact(c, fonts, ctx, target);
      return encodeMonoFrame(c, target);
    }

    switch (ctx.type) {
      case 'daily_calendar':
        renderDailyCalendarFrame(c, fonts, ctx, this.drawKit);
        break;
      case 'month_calendar':
        renderMonthCalendarFrame(c, fonts, ctx, this.drawKit);
        break;
      case 'weather':
        await renderWeatherFrame(c, fonts, ctx, this.drawKit);
        break;
      case 'history_today':
        renderHistoryTodayFrame(c, fonts, ctx, this.drawKit);
        break;
      case 'weather_alert':
        renderWeatherAlertFrame(c, fonts, ctx, this.drawKit);
        break;
      case 'earthquake_report':
        renderEarthquakeReportFrame(c, fonts, ctx, this.drawKit);
        break;
      case 'dashboard':
        renderDashboardFrame(c, fonts, ctx, this.drawKit);
        break;
      case 'font_test':
        renderFontTestFrame(c, fonts, ctx, this.drawKit);
        break;
      case 'hot_list':
        renderHotListFrame(c, fonts, ctx, this.drawKit);
        break;
      default:
        this.renderFallback(c, fonts, `未知动态类型 ${ctx.type}`);
        break;
    }

    return encodeMonoFrame(c, target);
  }

  private clearSystemStatusArea(c: BitmapCanvas, target: RenderTarget): void {
    c.fillRect(0, 0, target.width, STATUS_BAR_H, PIXEL_WHITE);
  }

  private renderFallback(c: BitmapCanvas, fonts: FontSet, message: string): void {
    this.drawKit.drawText(c, fonts.sans16, message, 200, 140, {
      align: 'center',
      maxWidth: 320,
      maxLines: 2,
      ellipsis: true,
    });
  }

  private renderCompact(
    c: BitmapCanvas,
    fonts: FontSet,
    ctx: DynamicRenderContext,
    target: RenderTarget
  ): void {
    const model = buildCompactFrameModel(ctx);
    if (model.invert) {
      c.fillRect(0, STATUS_BAR_H, target.width, target.height - STATUS_BAR_H, PIXEL_BLACK);
    }
    const fg = model.invert ? PIXEL_WHITE : PIXEL_BLACK;
    const bodyFont = model.fontId ? (fonts.catalog[model.fontId] ?? fonts.sans12) : fonts.sans12;

    c.drawHLine(0, STATUS_BAR_H - 1, target.width, PIXEL_BLACK);
    this.drawKit.drawText(c, fonts.sans16, model.title, 8, 18, {
      maxWidth: target.width - 16,
      maxLines: 1,
      ellipsis: true,
      color: PIXEL_BLACK,
    });

    let y = STATUS_BAR_H + 19;
    for (const line of model.lines.slice(0, 4)) {
      this.drawKit.drawText(c, bodyFont, line, 10, y, {
        maxWidth: target.width - 20,
        maxLines: 1,
        ellipsis: true,
        color: fg,
      });
      y += 22;
    }

    const stamp = ctx.renderedAt.toISOString().slice(11, 16);
    this.drawKit.drawText(c, fonts.metric12, stamp, target.width - 36, target.height - 8, {
      maxWidth: 30,
      align: 'right',
      maxLines: 1,
      color: fg,
    });
  }
}
