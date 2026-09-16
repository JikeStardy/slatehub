import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  DASHBOARD_CUSTOM_STARTER_TEMPLATE,
  FONT_TEST_FONTS,
  FRAME_BYTES,
  FRAME_HEIGHT,
  FRAME_WIDTH,
} from 'shared';
import {
  DASHBOARD_AI_QUOTA_MONITOR_TEST_DATA,
  DASHBOARD_AI_USAGE_STATS_TEST_DATA,
  DASHBOARD_CUSTOM_STARTER_TEST_DATA,
} from 'shared/dynamic/test-fixtures';
import { loadBitmapFont, textWidth, type BitmapFont } from './fonts/bitmap-font';
import {
  DynamicFrameRendererService,
  type DynamicRenderContext,
} from './dynamic-frame-renderer.service';
import { buildCompactFrameModel } from './compact-frame-model';
import { renderDashboardFrame } from './dashboard-frame-renderer';
import { DynamicFrameFontService, type FontSet } from './fonts/dynamic-frame-font.service';
import { BITMAP_1BPP_FONT_DIR } from '../../../infra/assets/asset-paths';
import {
  encodeMonoFrame,
  NOTE4_RENDER_TARGET,
  renderTargetForProfile,
} from '../../rendering/render-target';
import { BitmapCanvas, PIXEL_WHITE } from './bitmap-canvas';
import type { FrameDrawKit } from './frame-draw-kit';

const renderer = new DynamicFrameRendererService(new DynamicFrameFontService());
const renderedAt = new Date('2026-05-17T04:00:00.000Z');
const STATUS_BAR_H = 24;
const VIRTUAL_RENDER_TARGET = renderTargetForProfile('virtual-mono-296x128');

describe('DynamicFrameRendererService', () => {
  it('renders dynamic frames as nonblank 400x300 1bpp images', async () => {
    const contexts: DynamicRenderContext[] = [
      {
        type: 'daily_calendar',
        frameName: '日历',
        config: { tz: 'Asia/Shanghai' },
        data: {
          year: '2026',
          month: '5',
          day: '17',
          weekdayCN: '星期日',
          lunarDate: '农历四月初一',
          ganzhiYear: '丙午年',
          ganzhiMonth: '癸巳月',
          ganzhiDay: '辛卯日',
          nextSolarTerm: '小满',
          nextSolarTermDays: 4,
          yi: ['祭祀', '祈福', '求嗣', '开光'],
          ji: ['入宅', '修造', '安门', '伐木'],
        },
        renderedAt,
      },
      {
        type: 'month_calendar',
        frameName: '月历',
        config: { tz: 'Asia/Shanghai' },
        data: {
          calendar: {
            months: {
              '2026-05': {
                days: {
                  '2026-05-01': { lunar_date: '农历三月十五' },
                  '2026-05-05': { solar_term: '立夏', lunar_date: '农历三月十九' },
                  '2026-05-17': { lunar_date: '农历四月初一' },
                  '2026-05-21': { solar_term: '小满', lunar_date: '农历四月初五' },
                },
              },
            },
          },
        },
        renderedAt,
      },
      {
        type: 'weather',
        frameName: '天气',
        config: { location_label: '北京' },
        data: {
          tempC: 24,
          feelsLikeC: 26,
          humidity: 61,
          windDisplay: '东南风2级',
          summary: '多云',
          code: 101,
          fc: [
            { label: '今日', text: '多云', tempMin: 18, tempMax: 27, code: 101 },
            { label: '明日', text: '小雨', tempMin: 17, tempMax: 24, code: 305 },
            { label: '后天', text: '晴', tempMin: 19, tempMax: 29, code: 100 },
          ],
        },
        renderedAt,
      },
      {
        type: 'history_today',
        frameName: '历史',
        config: { tz: 'Asia/Shanghai' },
        data: {
          dateLabel: '5 月 17 日',
          items: [
            { year: '1792', display: '纽约证券交易所成立，现代金融市场制度逐步成形' },
            { year: '1865', display: '国际电信联盟在巴黎成立，推动全球通信协作' },
            { year: '1949', display: '中国人民解放军解放武汉三镇，华中局势改变' },
            { year: '1995', display: 'Java 编程语言正式发布，互联网软件生态扩张' },
            { year: '2008', display: '中国商飞公司在上海成立，国产大飞机项目提速' },
          ],
        },
        renderedAt,
      },
      {
        type: 'weather_alert',
        frameName: '气象预警',
        config: {
          type: 'weather_alert',
          province: '',
          refresh_interval_sec: 600,
        },
        data: {
          title: '全国气象预警',
          province: '',
          updatedAt: '2026-05-17T04:00:00.000Z',
          items: [
            {
              id: 'a1',
              title: '中央气象台发布暴雨黄色预警',
              issuedAt: '2026-05-17T03:30:00.000Z',
            },
            {
              id: 'a2',
              title: '广东省发布雷雨大风蓝色预警',
              issuedAt: '2026-05-17T02:10:00.000Z',
            },
          ],
        },
        renderedAt,
      },
      {
        type: 'earthquake_report',
        frameName: '地震速报',
        config: {
          type: 'earthquake_report',
          refresh_interval_sec: 600,
        },
        data: {
          title: '中国地震台网速报',
          updatedAt: '2026-05-17T04:00:00.000Z',
          sourceUrl: 'https://data.earthquake.cn/datashare/report.shtml?PAGEID=earthquake_subao',
          items: [
            {
              id: '1',
              occurredAt: '2026-5-17 11:27:06',
              longitude: '113.03',
              latitude: '39.96',
              depthKm: '-',
              magnitude: '3.2',
              location: '山西大同市云冈区',
              eventType: '天然地震',
            },
            {
              id: '2',
              occurredAt: '2026-5-17 01:16:27',
              longitude: '90.23',
              latitude: '33.47',
              depthKm: '10',
              magnitude: '4.1',
              location: '青海海西州唐古拉地区',
              eventType: '天然地震',
            },
          ],
        },
        renderedAt,
      },
      {
        type: 'dashboard',
        frameName: '外部数据',
        config: { type: 'dashboard', template: { kind: 'system', id: 'ai_usage_stats' } },
        data: DASHBOARD_AI_USAGE_STATS_TEST_DATA,
        renderedAt,
      },
      {
        type: 'dashboard',
        frameName: 'AI 限额监控',
        config: { type: 'dashboard', template: { kind: 'system', id: 'ai_quota_monitor' } },
        data: DASHBOARD_AI_QUOTA_MONITOR_TEST_DATA,
        renderedAt,
      },
      {
        type: 'dashboard',
        frameName: '自定义模板',
        config: {
          type: 'dashboard',
          template: {
            kind: 'custom',
            template: DASHBOARD_CUSTOM_STARTER_TEMPLATE,
          },
        },
        data: DASHBOARD_CUSTOM_STARTER_TEST_DATA,
        renderedAt,
      },
      {
        type: 'font_test',
        frameName: '字体测试',
        config: {
          type: 'font_test',
          font_id: 'unifont_16',
          invert: false,
        },
        data: null,
        renderedAt,
      },
      {
        type: 'hot_list',
        frameName: '微博热榜',
        config: {
          type: 'hot_list',
          source: 'weibo',
          refresh_interval_sec: 600,
        },
        data: {
          source: 'weibo',
          sourceLabel: '微博',
          updatedAt: '2026-05-17T04:00:00.000Z',
          items: [
            { rank: 1, title: '大型科技公司发布新一代墨水屏设备', hot: '893万热度' },
            { rank: 2, title: '本周全国多地迎来强降雨天气', hot: '421万热度' },
            { rank: 3, title: '开源社区讨论 TypeScript 新版本迁移策略', hot: '128万热度' },
            { rank: 4, title: '热门电影票房刷新五月纪录', hot: '96万热度' },
            { rank: 5, title: '城市骑行路线成为周末新选择', hot: '42万热度' },
            { rank: 6, title: '人工智能工具进入更多办公流程', hot: '39万热度' },
            { rank: 7, title: '年轻人开始整理家庭数字资产', hot: '31万热度' },
            { rank: 8, title: '假期短途旅行预订量继续增长', hot: '22万热度' },
          ],
        },
        renderedAt,
      },
    ];

    for (const ctx of contexts) {
      const frame = await renderer.render(ctx, NOTE4_RENDER_TARGET);
      expect(frame.byteLength).toBe(FRAME_BYTES);
      const stats = countPixels(frame, NOTE4_RENDER_TARGET.width, NOTE4_RENDER_TARGET.height);
      expect(stats.black).toBeGreaterThan(120);
      expect(stats.white).toBeGreaterThan(120);
    }
  });

  it('renders every built-in dynamic type through the compact virtual layout', async () => {
    for (const ctx of compactDynamicContexts()) {
      const frame = await renderer.render(ctx, VIRTUAL_RENDER_TARGET);
      expect(VIRTUAL_RENDER_TARGET.width).toBe(296);
      expect(VIRTUAL_RENDER_TARGET.height).toBe(128);
      expect(frame.byteLength).toBe(4736);
      const stats = countPixels(frame, VIRTUAL_RENDER_TARGET.width, VIRTUAL_RENDER_TARGET.height);
      expect(stats.black).toBeGreaterThan(40);
      expect(stats.white).toBeGreaterThan(40);
      const bounds = blackBounds2d(
        frame,
        VIRTUAL_RENDER_TARGET.width,
        VIRTUAL_RENDER_TARGET.height
      );
      expect(bounds).not.toBeNull();
      expect(bounds!.minX).toBeGreaterThanOrEqual(0);
      expect(bounds!.minY).toBeGreaterThanOrEqual(0);
      expect(bounds!.maxX).toBeLessThan(VIRTUAL_RENDER_TARGET.width);
      expect(bounds!.maxY).toBeLessThan(VIRTUAL_RENDER_TARGET.height);
    }
  });

  it('builds discriminating compact content for every built-in dynamic type', () => {
    const byType = new Map(compactDynamicContexts().map((ctx) => [ctx.type, ctx]));

    expect(buildCompactFrameModel(byType.get('daily_calendar')!).lines.join('\n')).toContain(
      '宜 祭祀 祈福'
    );
    expect(buildCompactFrameModel(byType.get('weather')!).lines.join('\n')).toContain('东南风2级');
    expect(buildCompactFrameModel(byType.get('history_today')!).lines.join('\n')).toContain(
      '纽交所成立'
    );
    expect(buildCompactFrameModel(byType.get('weather_alert')!).lines.join('\n')).toContain(
      '暴雨黄色预警'
    );
    expect(buildCompactFrameModel(byType.get('earthquake_report')!).lines.join('\n')).toContain(
      '山西大同市云冈区'
    );
    expect(buildCompactFrameModel(byType.get('dashboard')!).lines.join('\n')).toContain(
      'today_cost_usd'
    );
    expect(buildCompactFrameModel(byType.get('hot_list')!).lines.join('\n')).toContain(
      '墨水屏设备发布'
    );

    const month = buildCompactFrameModel(byType.get('month_calendar')!);
    expect(month.lines).toContain('2026-05 Asia/Shanghai');
    expect(month.lines).toContain('标注 2 天');

    const font = buildCompactFrameModel(byType.get('font_test')!);
    expect(font.fontId).toBe('ark_pixel_16');
    expect(font.invert).toBe(true);
    expect(font.lines.join('\n')).toContain('16px');
  });

  it('rejects unsupported reserved frame encodings at the boundary', () => {
    const canvas = new BitmapCanvas(NOTE4_RENDER_TARGET.width, NOTE4_RENDER_TARGET.height);
    canvas.clear(PIXEL_WHITE);

    expect(() =>
      encodeMonoFrame(canvas, {
        ...NOTE4_RENDER_TARGET,
        pixelFormat: 'reserved_pixel_format' as never,
      })
    ).toThrow(/不支持的帧编码/);
  });

  it('renders every font-test catalog entry', async () => {
    for (const font of FONT_TEST_FONTS) {
      const frame = await renderer.render(
        {
          type: 'font_test',
          frameName: font.label,
          config: {
            type: 'font_test',
            font_id: font.id,
            invert: false,
          },
          data: null,
          renderedAt,
        },
        NOTE4_RENDER_TARGET
      );
      expect(frame.byteLength).toBe(FRAME_BYTES);
      const stats = countPixels(frame, NOTE4_RENDER_TARGET.width, NOTE4_RENDER_TARGET.height);
      expect(stats.black).toBeGreaterThan(80);
      expect(stats.white).toBeGreaterThan(80);
    }
  });

  it('keeps dashboard system templates centered below the status bar', async () => {
    const contexts: DynamicRenderContext[] = [
      {
        type: 'dashboard',
        frameName: '外部数据',
        config: { type: 'dashboard', template: { kind: 'system', id: 'ai_usage_stats' } },
        data: DASHBOARD_AI_USAGE_STATS_TEST_DATA,
        renderedAt,
      },
      {
        type: 'dashboard',
        frameName: 'AI 限额监控',
        config: { type: 'dashboard', template: { kind: 'system', id: 'ai_quota_monitor' } },
        data: DASHBOARD_AI_QUOTA_MONITOR_TEST_DATA,
        renderedAt,
      },
    ];

    for (const ctx of contexts) {
      const frame = await renderer.render(ctx, NOTE4_RENDER_TARGET);
      const bounds = blackBounds(frame, 0, STATUS_BAR_H, FRAME_WIDTH, FRAME_HEIGHT - STATUS_BAR_H);

      expect(bounds).not.toBeNull();
      const topGap = bounds!.top - STATUS_BAR_H;
      const bottomGap = FRAME_HEIGHT - 1 - bounds!.bottom;
      expect(Math.abs(topGap - bottomGap)).toBeLessThanOrEqual(2);
    }
  });

  it('renders the dashboard empty-state ingest path with the public v2 API route', () => {
    const texts: string[] = [];
    const draw = {
      drawText: (_canvas: BitmapCanvas, _font: unknown, text: string, _x: number, _y: number) => {
        texts.push(text);
        return 0;
      },
    } as unknown as FrameDrawKit;

    renderDashboardFrame(
      new BitmapCanvas(),
      { sans16: {}, sans12: {} } as FontSet,
      {
        type: 'dashboard',
        frameName: '外部数据',
        config: { type: 'dashboard', template: { kind: 'system', id: 'ai_usage_stats' } },
        data: null,
        renderedAt,
      },
      draw
    );

    expect(texts).toEqual(['等待外部数据', 'POST /api/v2/contents/:id/data']);
  });

  it('centers hot-list rank boxes and title glyphs between row rules', async () => {
    const frame = await renderer.render(
      {
        type: 'hot_list',
        frameName: '热榜',
        config: {
          type: 'hot_list',
          source: 'weibo',
          refresh_interval_sec: 600,
        },
        data: {
          source: 'weibo',
          sourceLabel: '微博',
          updatedAt: '2026-05-17T04:00:00.000Z',
          items: [
            { rank: 1, title: '中俄关系迈上新起点' },
            { rank: 2, title: '全球唯一白色野生大熊猫影像公开' },
            { rank: 3, title: '斯凯奇被清仓' },
            { rank: 4, title: '外国博主扎堆中国乡村' },
            { rank: 5, title: '寒潮预警手机只会越来越贵' },
            { rank: 6, title: '歌手首场排名齐豫第一陈楚庆淘汰' },
            { rank: 7, title: '女子捡到金项链发现异常立马报掉' },
            { rank: 8, title: '黑龙江坚决拥护党中央决定' },
          ],
        },
        renderedAt,
      },
      NOTE4_RENDER_TARGET
    );

    const listTop = 34;
    const rowH = 33;
    const rankX = 20;
    const rankBoxW = 28;
    const titleX = 62;
    const titleW = 318;

    for (let index = 1; index <= 6; index++) {
      const rowY = listTop + index * rowH;
      const previousRuleY = rowY - 1;
      const nextRuleY = rowY + rowH - 1;
      const rowCenter = (previousRuleY + nextRuleY) / 2;
      const scanTop = previousRuleY + 1;
      const scanH = nextRuleY - previousRuleY - 1;

      const rankBounds = blackBounds(frame, rankX, scanTop, rankBoxW, scanH);
      expect(rankBounds).not.toBeNull();
      expect(centerY(rankBounds!)).toBe(rowCenter);

      const titleBounds = blackBounds(frame, titleX, scanTop, titleW, scanH);
      expect(titleBounds).not.toBeNull();
      expect(Math.abs(centerY(titleBounds!) - rowCenter)).toBeLessThanOrEqual(1);
    }
  });

  it('renders weather-alert rows with alert kind badge and source text', async () => {
    const frame = await renderer.render(
      {
        type: 'weather_alert',
        frameName: '气象预警',
        config: {
          type: 'weather_alert',
          province: '',
          refresh_interval_sec: 600,
        },
        data: {
          title: '全国气象预警',
          province: '',
          updatedAt: '2026-05-17T04:00:00.000Z',
          items: [
            {
              id: 'a1',
              title: '中央气象台发布暴雨黄色预警',
              issuedAt: '2026-05-17T03:30:00.000Z',
            },
          ],
        },
        renderedAt,
      },
      NOTE4_RENDER_TARGET
    );
    const font = await loadTestFont('source-han-sans-16-slim.json');
    const badgeFont = await loadTestFont('fusion-pixel-10.json');

    expect(hasTextPixels(frame, badgeFont, '暴雨', 20, 33, 34, 30)).toBe(true);
    expect(hasTextPixels(frame, font, '黄', 64, 33, 40, 22)).toBe(true);
    expect(hasTextPixels(frame, font, '中央气象台', 64, 33, 170, 22)).toBe(true);
  });

  it('does not hard truncate weather-alert local source names before fitting', async () => {
    const frame = await renderer.render(
      {
        type: 'weather_alert',
        frameName: '气象预警',
        config: {
          type: 'weather_alert',
          province: '',
          refresh_interval_sec: 600,
        },
        data: {
          title: '全国气象预警',
          province: '',
          updatedAt: '2026-05-17T04:00:00.000Z',
          items: [
            {
              id: 'a1',
              title: '贵州省黔西南布依族苗族自治州发布暴雨黄色预警信号',
              issuedAt: '2026-05-17T03:30:00.000Z',
            },
          ],
        },
        renderedAt,
      },
      NOTE4_RENDER_TARGET
    );
    const font = await loadTestFont('source-han-sans-16-slim.json');

    expect(hasTextPixels(frame, font, '黔西南', 114, 33, 130, 22)).toBe(true);
  });
});

function countPixels(
  frame: Buffer,
  width: number,
  height: number
): { black: number; white: number } {
  let black = 0;
  let white = 0;
  const bpr = width >> 3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byte = frame[y * bpr + (x >> 3)]!;
      const bit = (byte >> (7 - (x & 7))) & 1;
      if (bit) white++;
      else black++;
    }
  }
  return { black, white };
}

function blackBounds2d(
  frame: Buffer,
  width: number,
  height: number
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  const bpr = width >> 3;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byte = frame[y * bpr + (x >> 3)]!;
      const bit = (byte >> (7 - (x & 7))) & 1;
      if (bit) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null;
}

function compactDynamicContexts(): DynamicRenderContext[] {
  return [
    {
      type: 'daily_calendar',
      frameName: '日历',
      config: { tz: 'Asia/Shanghai' },
      data: {
        year: '2026',
        month: '5',
        day: '17',
        weekdayCN: '星期日',
        lunarDate: '农历四月初一',
        ganzhiYear: '丙午年',
        yi: ['祭祀', '祈福'],
        ji: ['入宅', '修造'],
      },
      renderedAt,
    },
    {
      type: 'month_calendar',
      frameName: '月历',
      config: { tz: 'Asia/Shanghai' },
      data: {
        calendar: {
          months: {
            '2026-05': {
              days: {
                '2026-05-05': { solar_term: '立夏' },
                '2026-05-21': { solar_term: '小满' },
              },
            },
          },
        },
      },
      renderedAt,
    },
    {
      type: 'weather',
      frameName: '天气',
      config: { location_label: '北京' },
      data: {
        tempC: 24,
        feelsLikeC: 26,
        humidity: 61,
        windDisplay: '东南风2级',
        summary: '多云',
      },
      renderedAt,
    },
    {
      type: 'history_today',
      frameName: '历史',
      config: { tz: 'Asia/Shanghai' },
      data: { dateLabel: '5 月 17 日', items: [{ year: '1792', display: '纽交所成立' }] },
      renderedAt,
    },
    {
      type: 'weather_alert',
      frameName: '气象预警',
      config: { type: 'weather_alert', province: '', refresh_interval_sec: 600 },
      data: { title: '全国气象预警', items: [{ title: '暴雨黄色预警' }] },
      renderedAt,
    },
    {
      type: 'earthquake_report',
      frameName: '地震速报',
      config: { type: 'earthquake_report', refresh_interval_sec: 600 },
      data: { title: '中国地震台网速报', items: [{ location: '山西大同市云冈区' }] },
      renderedAt,
    },
    {
      type: 'dashboard',
      frameName: '外部数据',
      config: { type: 'dashboard', template: { kind: 'system', id: 'ai_usage_stats' } },
      data: DASHBOARD_AI_USAGE_STATS_TEST_DATA,
      renderedAt,
    },
    {
      type: 'font_test',
      frameName: '字体测试',
      config: { type: 'font_test', font_id: 'ark_pixel_16', invert: true },
      data: null,
      renderedAt,
    },
    {
      type: 'hot_list',
      frameName: '微博热榜',
      config: { type: 'hot_list', source: 'weibo', refresh_interval_sec: 600 },
      data: { sourceLabel: '微博', items: [{ rank: 1, title: '墨水屏设备发布' }] },
      renderedAt,
    },
  ];
}

function blackBounds(
  frame: Buffer,
  x: number,
  y: number,
  w: number,
  h: number
): { top: number; bottom: number } | null {
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (!isBlack(frame, xx, yy)) continue;
      top = Math.min(top, yy);
      bottom = Math.max(bottom, yy);
    }
  }
  return Number.isFinite(top) && Number.isFinite(bottom) ? { top, bottom } : null;
}

function centerY(bounds: { top: number; bottom: number }): number {
  return (bounds.top + bounds.bottom) / 2;
}

function isBlack(frame: Buffer, x: number, y: number): boolean {
  const bpr = FRAME_WIDTH >> 3;
  const byte = frame[y * bpr + (x >> 3)]!;
  return ((byte >> (7 - (x & 7))) & 1) === 0;
}

function loadTestFont(file: string): Promise<BitmapFont> {
  return loadBitmapFont(join(BITMAP_1BPP_FONT_DIR, file));
}

function hasTextPixels(
  frame: Buffer,
  font: BitmapFont,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number
): boolean {
  const target = renderTextMask(font, text);
  for (let yy = y; yy <= y + h - font.lineHeight; yy++) {
    for (let xx = x; xx <= x + w - target.width; xx++) {
      if (matchesTextMask(frame, target, xx, yy)) return true;
    }
  }
  return false;
}

function renderTextMask(
  font: BitmapFont,
  text: string
): { width: number; height: number; pixels: Uint8Array } {
  const width = textWidth(font, text);
  const height = font.lineHeight;
  const pixels = new Uint8Array(width * height);
  let penX = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const glyph = font.glyphs.get(cp);
    if (!glyph) continue;
    const baselineY = font.lineHeight - font.baseLine;
    const startX = penX + glyph.ofs_x;
    const startY = baselineY - glyph.ofs_y - glyph.box_h;
    let bit = glyph.bitmap_index * 8;
    for (let yy = 0; yy < glyph.box_h; yy++) {
      for (let xx = 0; xx < glyph.box_w; xx++) {
        const byte = font.bitmap[bit >> 3] ?? 0;
        const on = (byte & (0x80 >> (bit & 7))) !== 0;
        if (on) {
          const px = startX + xx;
          const py = startY + yy;
          if (px >= 0 && py >= 0 && px < width && py < height) pixels[py * width + px] = 1;
        }
        bit++;
      }
    }
    penX += Math.round(glyph.adv_w / 16);
  }
  return { width, height, pixels };
}

function matchesTextMask(
  frame: Buffer,
  target: { width: number; height: number; pixels: Uint8Array },
  x: number,
  y: number
): boolean {
  for (let yy = 0; yy < target.height; yy++) {
    for (let xx = 0; xx < target.width; xx++) {
      if (!target.pixels[yy * target.width + xx]) continue;
      if (!isBlack(frame, x + xx, y + yy)) return false;
    }
  }
  return true;
}
