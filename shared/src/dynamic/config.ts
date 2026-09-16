import { z } from 'zod';
import { HotListConfig } from './hot-list-sources.js';
import { FontTestFontId } from './fonts.js';
import {
  DASHBOARD_CUSTOM_STARTER_TEMPLATE,
  DashboardSystemTemplateId,
  DashboardTemplate,
} from './templates.js';

// 内置动态内容类型清单。每种对应一个服务端 compiler + 设备端基础 block 组合。
export const DynamicType = z.enum([
  'daily_calendar',
  'month_calendar',
  'weather',
  'history_today',
  'weather_alert',
  'earthquake_report',
  'dashboard',
  'font_test',
  'hot_list',
]);
export type DynamicTypeT = z.infer<typeof DynamicType>;

// IANA 时区。前端默认用浏览器 Intl.DateTimeFormat().resolvedOptions().timeZone。
const Tz = z.string().min(1).max(48);

export const TTS_VOICES = ['冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'] as const;
export const DEFAULT_TTS_VOICE = '冰糖';
export const TtsVoice = z.enum(TTS_VOICES);
export type TtsVoiceT = z.infer<typeof TtsVoice>;

export function isTtsVoice(value: string): value is TtsVoiceT {
  return (TTS_VOICES as readonly string[]).includes(value);
}

const DynamicAudioOptions = z.object({
  audio_enabled: z.boolean().default(false),
  audio_voice: TtsVoice.default(DEFAULT_TTS_VOICE),
});

const DynamicRefreshOptions = z.object({
  refresh_interval_sec: z.coerce.number().int().min(300).max(86400).optional(),
});

// 各动态内容类型的 config schema。discriminated union 让前后端共用同一份校验。

export const DailyCalendarConfig = z
  .object({
    type: z.literal('daily_calendar'),
    tz: Tz,
  })
  .merge(DynamicAudioOptions)
  .merge(DynamicRefreshOptions);
export type DailyCalendarConfigT = z.infer<typeof DailyCalendarConfig>;

export const MonthCalendarConfig = z
  .object({
    type: z.literal('month_calendar'),
    tz: Tz,
  })
  .merge(DynamicAudioOptions)
  .merge(DynamicRefreshOptions);
export type MonthCalendarConfigT = z.infer<typeof MonthCalendarConfig>;

export const WeatherConfig = z
  .object({
    type: z.literal('weather'),
    tz: Tz,
    provider: z.enum(['qweather']).default('qweather'),
    location_id: z.string().min(1).max(32),
    location_label: z.string().min(1).max(32),
  })
  .merge(DynamicAudioOptions)
  .merge(DynamicRefreshOptions);
export type WeatherConfigT = z.infer<typeof WeatherConfig>;

export const HistoryTodayConfig = z
  .object({
    type: z.literal('history_today'),
    tz: Tz,
    source: z.enum(['wikipedia', 'baidu_baike']).default('wikipedia'),
  })
  .merge(DynamicAudioOptions)
  .merge(DynamicRefreshOptions);
export type HistoryTodayConfigT = z.infer<typeof HistoryTodayConfig>;

export const WEATHER_ALERT_PROVINCES = [
  '北京市',
  '上海市',
  '天津市',
  '重庆市',
  '黑龙江省',
  '吉林省',
  '辽宁省',
  '内蒙古自治区',
  '河北省',
  '山西省',
  '陕西省',
  '山东省',
  '新疆维吾尔自治区',
  '西藏自治区',
  '青海省',
  '甘肃省',
  '宁夏回族自治区',
  '河南省',
  '江苏省',
  '湖北省',
  '浙江省',
  '安徽省',
  '福建省',
  '江西省',
  '湖南省',
  '贵州省',
  '四川省',
  '广东省',
  '云南省',
  '广西壮族自治区',
  '海南省',
] as const;
export type WeatherAlertProvinceT = (typeof WEATHER_ALERT_PROVINCES)[number];

const weatherAlertProvinceAliases = new Map<string, WeatherAlertProvinceT>(
  WEATHER_ALERT_PROVINCES.flatMap((province) => {
    const aliases = new Set<string>([
      province,
      province.replace(/省$|市$/, ''),
      province.replace(/(?:壮族|回族|维吾尔)?自治区$/, ''),
      province.replace(/(?:壮族|回族|维吾尔)自治区$/, '自治区'),
    ]);
    aliases.delete('');
    return [...aliases].map((alias) => [alias, province] as const);
  })
);

export function isWeatherAlertProvince(value: string): value is WeatherAlertProvinceT {
  return (WEATHER_ALERT_PROVINCES as readonly string[]).includes(value);
}

export function normalizeWeatherAlertProvince(value: string): string {
  const text = value.trim();
  if (!text || text === '全国' || text === '全部' || text === '中国') return '';
  return weatherAlertProvinceAliases.get(text) ?? '';
}

export const WeatherAlertConfig = z
  .object({
    type: z.literal('weather_alert'),
    province: z.string().max(16).default(''),
    refresh_interval_sec: z.coerce.number().int().min(300).max(86400).default(600),
  })
  .merge(DynamicAudioOptions);
export type WeatherAlertConfigT = z.infer<typeof WeatherAlertConfig>;

export const EarthquakeReportConfig = z
  .object({
    type: z.literal('earthquake_report'),
    refresh_interval_sec: z.coerce.number().int().min(300).max(86400).default(600),
  })
  .merge(DynamicAudioOptions);
export type EarthquakeReportConfigT = z.infer<typeof EarthquakeReportConfig>;

export const DashboardTemplateRef = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('system'),
    id: DashboardSystemTemplateId.default('ai_usage_stats'),
  }),
  z.object({
    kind: z.literal('custom'),
    template: DashboardTemplate,
  }),
]);
export type DashboardTemplateRefT = z.infer<typeof DashboardTemplateRef>;

export const DashboardDataPayload = z
  .record(z.string().max(64), z.unknown())
  .refine((data) => Object.keys(data).length > 0, '必须至少包含一个字段');
export type DashboardDataPayloadT = z.infer<typeof DashboardDataPayload>;

export const DashboardConfig = z.object({
  type: z.literal('dashboard'),
  template: DashboardTemplateRef.default({
    kind: 'custom',
    template: DASHBOARD_CUSTOM_STARTER_TEMPLATE,
  }),
  refresh_interval_sec: z.coerce.number().int().min(60).max(86400).default(600),
});
export type DashboardConfigT = z.infer<typeof DashboardConfig>;

export const FontTestConfig = z.object({
  type: z.literal('font_test'),
  font_id: FontTestFontId.default('fusion_pixel_12'),
  invert: z.boolean().default(false),
});
export type FontTestConfigT = z.infer<typeof FontTestConfig>;

export const DynamicConfig = z.discriminatedUnion('type', [
  DailyCalendarConfig,
  MonthCalendarConfig,
  WeatherConfig,
  HistoryTodayConfig,
  WeatherAlertConfig,
  EarthquakeReportConfig,
  DashboardConfig,
  FontTestConfig,
  HotListConfig,
]);
export type DynamicConfigT = z.infer<typeof DynamicConfig>;

export function isAudioDynamicConfig(config: DynamicConfigT): config is Extract<
  DynamicConfigT,
  {
    type:
      | 'daily_calendar'
      | 'month_calendar'
      | 'weather'
      | 'history_today'
      | 'weather_alert'
      | 'earthquake_report';
  }
> {
  return (
    config.type === 'daily_calendar' ||
    config.type === 'month_calendar' ||
    config.type === 'weather' ||
    config.type === 'history_today' ||
    config.type === 'weather_alert' ||
    config.type === 'earthquake_report'
  );
}

// POST /api/v2/contents/:contentId/data —— 外部数据推送（仅 dashboard 动态内容）。
//   capability URL: contentId(cuid，~110 bit 熵) 本身充当访问能力，不需要额外 token。
//   防滥用靠 bodyLimit 64KB + rate-limit 30/min/contentId。
export const IngestPayload = z
  .object({
    version: z.literal(1),
    data: DashboardDataPayload,
  })
  .strict();
export type IngestPayloadT = z.infer<typeof IngestPayload>;

export const IngestResponse = z.object({
  id: z.string(),
  image_etag: z.string(),
  manifest_etag: z.string(),
  rendered_at: z.string().datetime(),
});
export type IngestResponseT = z.infer<typeof IngestResponse>;
