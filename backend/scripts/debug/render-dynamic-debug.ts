#!/usr/bin/env bun
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  DASHBOARD_CUSTOM_STARTER_TEMPLATE,
  DEFAULT_TTS_VOICE,
  FONT_TEST_FONTS,
  FRAME_HEIGHT,
  FRAME_WIDTH,
} from 'shared';
import {
  DASHBOARD_AI_QUOTA_MONITOR_TEST_DATA,
  DASHBOARD_AI_USAGE_STATS_TEST_DATA,
  DASHBOARD_CUSTOM_STARTER_TEST_DATA,
} from 'shared/dynamic/test-fixtures';
import {
  DynamicFrameRendererService,
  type DynamicRenderContext,
} from '../../src/modules/dynamic-content/rendering/dynamic-frame-renderer.service';
import { DynamicFrameFontService } from '../../src/modules/dynamic-content/rendering/fonts/dynamic-frame-font.service';
import { NOTE4_RENDER_TARGET } from '../../src/modules/rendering/render-target';
import { CalendarDataService } from '../../src/modules/dynamic-content/calendar-data.service';
import { DailyCalendarProvider } from '../../src/modules/dynamic-content/providers/daily-calendar.provider';

const outDir = process.argv[2] ?? '/private/tmp/slate-render-debug';
const renderedAt = new Date('2026-05-17T04:00:00.000Z');
const tz = 'Asia/Shanghai';

await mkdir(outDir, { recursive: true });

const renderer = new DynamicFrameRendererService(new DynamicFrameFontService());
const calendar = new CalendarDataService();
const daily = new DailyCalendarProvider();

const contexts: DynamicRenderContext[] = [
  {
    type: 'daily_calendar',
    frameName: '日历',
    config: { tz, audio_enabled: false, audio_voice: DEFAULT_TTS_VOICE },
    data: asRecord(
      await daily.fetchData(
        { type: 'daily_calendar', tz, audio_enabled: false, audio_voice: DEFAULT_TTS_VOICE },
        { now: renderedAt }
      )
    ),
    renderedAt,
  },
  {
    type: 'month_calendar',
    frameName: '月历',
    config: { tz, audio_enabled: false, audio_voice: DEFAULT_TTS_VOICE },
    data: asRecord(calendar.buildCurrentAndNextMonth(renderedAt, tz)),
    renderedAt,
  },
  {
    type: 'weather',
    frameName: '天气',
    config: {
      provider: 'qweather',
      location_id: '101010100',
      location_label: '北京',
      tz,
      audio_enabled: false,
      audio_voice: DEFAULT_TTS_VOICE,
    },
    data: {
      tempC: 24,
      feelsLikeC: 26,
      humidity: 61,
      pressure: 1008,
      windDisplay: '东南风2级',
      summary: '多云',
      code: 101,
      obsTime: renderedAt.toISOString(),
      updatedAt: renderedAt.toISOString(),
      fc: [
        { label: '今日', text: '多云', tempMin: 18, tempMax: 27, code: 101, val: '多云 18~27°' },
        { label: '明日', text: '小雨', tempMin: 17, tempMax: 24, code: 305, val: '小雨 17~24°' },
        { label: '后天', text: '晴', tempMin: 19, tempMax: 29, code: 100, val: '晴 19~29°' },
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
      tz,
      audio_enabled: false,
      audio_voice: DEFAULT_TTS_VOICE,
    },
    data: {
      title: '全国气象预警',
      province: '',
      updatedAt: renderedAt.toISOString(),
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
        {
          id: 'a3',
          title: '四川省发布高温橙色预警',
          issuedAt: '2026-05-17T01:40:00.000Z',
        },
        {
          id: 'a4',
          title: '浙江省发布大雾黄色预警',
          issuedAt: '2026-05-17T00:50:00.000Z',
        },
        {
          id: 'a5',
          title: '福建省发布台风蓝色预警',
          issuedAt: '2026-05-16T23:35:00.000Z',
        },
        {
          id: 'a6',
          title: '重庆市发布山洪灾害红色预警',
          issuedAt: '2026-05-16T22:15:00.000Z',
        },
        {
          id: 'a7',
          title: '河北省发布雷电黄色预警',
          issuedAt: '2026-05-16T21:20:00.000Z',
        },
        {
          id: 'a8',
          title: '广西壮族自治区发布暴雨橙色预警',
          issuedAt: '2026-05-16T20:05:00.000Z',
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
      tz,
      audio_enabled: false,
      audio_voice: DEFAULT_TTS_VOICE,
    },
    data: {
      title: '中国地震台网速报',
      updatedAt: renderedAt.toISOString(),
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
        {
          id: '3',
          occurredAt: '2026-5-16 23:08:44',
          longitude: '102.12',
          latitude: '29.53',
          depthKm: '8',
          magnitude: '3.6',
          location: '四川雅安市石棉县',
          eventType: '天然地震',
        },
        {
          id: '4',
          occurredAt: '2026-5-16 19:42:10',
          longitude: '121.74',
          latitude: '24.03',
          depthKm: '12',
          magnitude: '4.8',
          location: '台湾花莲县海域',
          eventType: '天然地震',
        },
        {
          id: '5',
          occurredAt: '2026-5-16 16:21:08',
          longitude: '82.44',
          latitude: '41.18',
          depthKm: '15',
          magnitude: '3.9',
          location: '新疆阿克苏地区库车市',
          eventType: '天然地震',
        },
      ],
    },
    renderedAt,
  },
  {
    type: 'history_today',
    frameName: '历史',
    config: { tz, audio_enabled: false, audio_voice: DEFAULT_TTS_VOICE },
    data: {
      dateLabel: '5月17日',
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
  ...FONT_TEST_FONTS.map((font) => ({
    type: 'font_test',
    frameName: font.label,
    config: {
      type: 'font_test',
      font_id: font.id,
      invert: false,
    },
    data: null,
    renderedAt,
  })),
];

for (const ctx of contexts) {
  const frame = await renderer.render(ctx, NOTE4_RENDER_TARGET);
  const gray = unpack1bpp(frame);
  const png = await sharp(gray, {
    raw: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 1 },
  })
    .png()
    .toBuffer();
  const file = join(outDir, `${debugFileName(ctx)}.png`);
  await writeFile(file, png);
  process.stdout.write(`${file} ${frame.byteLength} bytes\n`);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function debugFileName(ctx: DynamicRenderContext): string {
  if (ctx.type === 'dashboard' && isCustomDashboardConfig(ctx.config)) return 'dashboard-custom';
  if (ctx.type === 'dashboard')
    return `dashboard-${dashboardSystemTemplateId(ctx.config) ?? 'system'}`;
  if (ctx.type !== 'font_test') return ctx.type;
  return `font-test-${String(ctx.config.font_id ?? 'unknown').replace(/[^a-z0-9_-]+/gi, '-')}`;
}

function isCustomDashboardConfig(config: Record<string, unknown>): boolean {
  return isNonEmptyRecord(config.template) && config.template.kind === 'custom';
}

function dashboardSystemTemplateId(config: Record<string, unknown>): string | null {
  if (!isNonEmptyRecord(config.template) || config.template.kind !== 'system') return null;
  return typeof config.template.id === 'string' ? config.template.id : null;
}

function unpack1bpp(buf: Buffer): Buffer {
  const out = Buffer.alloc(FRAME_WIDTH * FRAME_HEIGHT);
  const bpr = FRAME_WIDTH >> 3;
  for (let y = 0; y < FRAME_HEIGHT; y++) {
    for (let x = 0; x < FRAME_WIDTH; x++) {
      const byte = buf[y * bpr + (x >> 3)]!;
      const bit = (byte >> (7 - (x & 7))) & 1;
      out[y * FRAME_WIDTH + x] = bit ? 255 : 0;
    }
  }
  return out;
}

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return (
    !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
  );
}
