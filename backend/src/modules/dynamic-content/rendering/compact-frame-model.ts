import { getDeviceFontEntry } from './fonts/font-catalog';
import { readFontId } from './fonts/font-test-utils';
import type { DynamicRenderContext } from './dynamic-render-context';

export interface CompactFrameModel {
  title: string;
  lines: string[];
  invert: boolean;
  fontId: string | null;
}

export function buildCompactFrameModel(ctx: DynamicRenderContext): CompactFrameModel {
  const data = isRecord(ctx.data) ? ctx.data : {};
  switch (ctx.type) {
    case 'daily_calendar':
      return model(ctx, [
        `${value(data.year)}-${value(data.month)}-${value(data.day)} ${value(data.weekdayCN)}`,
        `${value(data.lunarDate)} ${value(data.ganzhiYear)}`,
        `宜 ${joinValues(data.yi)}`,
        `忌 ${joinValues(data.ji)}`,
      ]);
    case 'month_calendar':
      return model(ctx, monthCalendarLines(ctx, data));
    case 'weather':
      return model(ctx, [
        `${value(data.summary)} ${value(data.tempC)}C`,
        `${value(data.windDisplay)} 湿度 ${value(data.humidity)}%`,
        `体感 ${value(data.feelsLikeC)}C`,
      ]);
    case 'history_today':
      return model(ctx, [value(data.dateLabel), ...itemTexts(data.items, 'display')]);
    case 'weather_alert':
      return model(ctx, [value(data.title), ...itemTexts(data.items, 'title')]);
    case 'earthquake_report':
      return model(ctx, [value(data.title), ...itemTexts(data.items, 'location')]);
    case 'dashboard':
      return model(ctx, dashboardLines(data));
    case 'font_test':
      return fontTestModel(ctx);
    case 'hot_list':
      return model(ctx, [value(data.sourceLabel), ...itemTexts(data.items, 'title')]);
    default:
      return model(ctx, ['暂无数据']);
  }
}

function model(ctx: DynamicRenderContext, lines: string[]): CompactFrameModel {
  return {
    title: compactTitle(ctx),
    lines: lines.filter((line) => line.trim().length > 0),
    invert: false,
    fontId: null,
  };
}

function fontTestModel(ctx: DynamicRenderContext): CompactFrameModel {
  const fontId = readFontId(ctx.config.font_id);
  const entry = getDeviceFontEntry(fontId);
  return {
    title: ctx.frameName || entry.label,
    lines: [entry.label, `${entry.sizePx}px ${entry.kind}`, '中文字体测试 1234'],
    invert: ctx.config.invert === true,
    fontId: entry.id,
  };
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

function monthCalendarLines(ctx: DynamicRenderContext, data: Record<string, unknown>): string[] {
  const tz = typeof ctx.config.tz === 'string' ? ctx.config.tz : 'UTC';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(ctx.renderedAt);
  const year = parts.find((part) => part.type === 'year')?.value ?? '';
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  const key = `${year}-${month}`;
  const monthData = readMonthData(data, key);
  const annotatedDays = Object.keys(monthData?.days ?? {}).length;
  return [`${key} ${tz}`, `标注 ${annotatedDays} 天`];
}

function readMonthData(
  data: Record<string, unknown>,
  key: string
): { days?: Record<string, unknown> } | null {
  const calendar = isRecord(data.calendar) ? data.calendar : {};
  const months = isRecord(calendar.months) ? calendar.months : {};
  const month = months[key];
  return isRecord(month) ? month : null;
}

function dashboardLines(data: Record<string, unknown>): string[] {
  const entries = Object.entries(data)
    .filter(([, v]) => v !== null && typeof v !== 'object')
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${value(v)}`);
  return entries.length > 0 ? entries : ['外部数据已更新'];
}

function itemTexts(items: unknown, key: string): string[] {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 3).map((item, index) => {
    if (!isRecord(item)) return `${index + 1}. ${value(item)}`;
    return `${value(item.rank) || value(item.year) || index + 1}. ${value(item[key])}`;
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
