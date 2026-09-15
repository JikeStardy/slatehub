import { Injectable } from '@nestjs/common';
import { BitmapCanvas, PIXEL_BLACK, PIXEL_WHITE } from './bitmap-canvas';
import {
  renderDailyCalendarFrame,
  renderHistoryTodayFrame,
  renderMonthCalendarFrame,
} from './calendar-frame-renderer';
import { renderDashboardFrame } from './dashboard-frame-renderer';
import type { DynamicRenderContext } from './dynamic-render-context';
import { renderEarthquakeReportFrame } from './earthquake-frame-renderer';
import { FrameDrawKit } from './frame-draw-kit';
import { STATUS_BAR_H } from './frame-renderer-layout';
import { DynamicFrameFontService, type FontSet } from './fonts/dynamic-frame-font.service';
import { renderFontTestFrame } from './font-test-frame-renderer';
import { renderHotListFrame } from './hot-list-frame-renderer';
import { encodeMonoFrame, type RenderTarget } from './render-target';
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
    const title = compactTitle(ctx);
    c.drawHLine(0, STATUS_BAR_H - 1, target.width, PIXEL_BLACK);
    this.drawKit.drawText(c, fonts.sans16, title, 8, 18, {
      maxWidth: target.width - 16,
      maxLines: 1,
      ellipsis: true,
    });

    const lines = compactLines(ctx);
    let y = STATUS_BAR_H + 19;
    for (const line of lines.slice(0, 4)) {
      this.drawKit.drawText(c, fonts.sans12, line, 10, y, {
        maxWidth: target.width - 20,
        maxLines: 1,
        ellipsis: true,
      });
      y += 22;
    }

    const stamp = ctx.renderedAt.toISOString().slice(11, 16);
    this.drawKit.drawText(c, fonts.metric12, stamp, target.width - 36, target.height - 8, {
      maxWidth: 30,
      align: 'right',
      maxLines: 1,
    });
  }
}

function compactTitle(ctx: DynamicRenderContext): string {
  if (ctx.frameName) return ctx.frameName;
  switch (ctx.type) {
    case 'daily_calendar':
      return '日历';
    case 'month_calendar':
      return '月历';
    case 'weather':
      return '天气';
    case 'history_today':
      return '历史今天';
    case 'weather_alert':
      return '气象预警';
    case 'earthquake_report':
      return '地震速报';
    case 'dashboard':
      return '仪表盘';
    case 'font_test':
      return '字体测试';
    case 'hot_list':
      return '热榜';
    default:
      return `动态内容 ${ctx.type}`;
  }
}

function compactLines(ctx: DynamicRenderContext): string[] {
  const data = isRecord(ctx.data) ? ctx.data : {};
  switch (ctx.type) {
    case 'daily_calendar':
      return [
        `${value(data.year)}-${value(data.month)}-${value(data.day)} ${value(data.weekdayCN)}`,
        `${value(data.lunarDate)} ${value(data.ganzhiYear)}`,
        `宜 ${joinValues(data.yi)}`,
        `忌 ${joinValues(data.ji)}`,
      ];
    case 'month_calendar':
      return [
        `${ctx.renderedAt.getUTCFullYear()}-${ctx.renderedAt.getUTCMonth() + 1}`,
        '本月日历已更新',
      ];
    case 'weather':
      return [
        `${value(data.summary)} ${value(data.tempC)}°C`,
        `${value(data.windDisplay)} 湿度 ${value(data.humidity)}%`,
        `体感 ${value(data.feelsLikeC)}°C`,
      ];
    case 'history_today':
      return [value(data.dateLabel), ...itemTitles(data.items)];
    case 'weather_alert':
      return [value(data.title), ...itemTitles(data.items)];
    case 'earthquake_report':
      return [value(data.title), ...itemTitles(data.items, 'location')];
    case 'dashboard':
      return dashboardLines(data);
    case 'font_test':
      return ['The quick brown fox', '中文字体测试 1234', 'Mono 1bpp compact'];
    case 'hot_list':
      return [value(data.sourceLabel), ...itemTitles(data.items)];
    default:
      return ['暂无数据'];
  }
}

function dashboardLines(data: Record<string, unknown>): string[] {
  const entries = Object.entries(data)
    .filter(([, v]) => v !== null && typeof v !== 'object')
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${value(v)}`);
  return entries.length > 0 ? entries : ['外部数据已更新'];
}

function itemTitles(items: unknown, key = 'title'): string[] {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 3).map((item, index) => {
    if (!isRecord(item)) return `${index + 1}. ${value(item)}`;
    return `${value(item.rank) || index + 1}. ${value(item[key])}`;
  });
}

function joinValues(value_: unknown): string {
  return Array.isArray(value_) ? value_.map(value).filter(Boolean).join(' ') : value(value_);
}

function value(value_: unknown): string {
  if (value_ === null || value_ === undefined) return '';
  return String(value_);
}

function isRecord(value_: unknown): value_ is Record<string, unknown> {
  return typeof value_ === 'object' && value_ !== null && !Array.isArray(value_);
}
