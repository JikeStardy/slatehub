import { Injectable } from '@nestjs/common';
import { HistoryTodayConfig, type HistoryTodayConfigT } from 'shared';
import { AiService } from '../../ai/ai.service';
import type { DataProvider, DynamicContentFetchCtx } from '../dynamic-content.types';
import { stripHtml } from '../../../common/utils/html-text';
import {
  normalizeHistoryYear,
  parseHistoryTodayData,
  type HistoryTodayProviderData,
} from '../history-today.data';
import { datePartsInTz } from '../timezone';
import { fetchJson } from '../../../common/http/fetch';
import { setBoundedCache } from '../../../common/utils/cache-utils';
import { CachedInflightFetcher, DEFAULT_PROVIDER_FETCH_TIMEOUT_MS } from './provider-cache';

const CACHE_TTL_MS = 86_400_000;
const RAW_LANG = 'zh-cn';
const WIKIMEDIA_USER_AGENT =
  'SlateHub/0.2 (+https://github.com/JikeStardy/slatehub; history-today-provider)';
const MAX_RAW_CACHE_ENTRIES = 64;
const MAX_AI_CACHE_ENTRIES = 256;

/**
 * 历史上的今天。
 *
 * 数据来源：维基百科中文 REST API
 * GET https://zh.wikipedia.org/api/rest_v1/feed/onthisday/events/{MM}/{DD}?variant=zh-cn
 * 请求简体变体。
 *
 * AI 是强约束：负责筛选、简繁转换和压缩；失败时抛错，不能渲染 raw events。
 */
@Injectable()
export class HistoryTodayProvider implements DataProvider<
  HistoryTodayConfigT,
  HistoryTodayProviderData
> {
  readonly type = 'history_today';
  private readonly rawCache = new Map<
    string,
    { events: HistoryTodayRawEvent[]; fetchedAt: number }
  >();
  private readonly resultFetcher = new CachedInflightFetcher<string, HistoryTodayProviderData>(
    MAX_AI_CACHE_ENTRIES
  );

  constructor(private readonly ai: AiService) {}

  validateConfig(raw: unknown): HistoryTodayConfigT {
    return HistoryTodayConfig.parse(raw);
  }

  async fetchData(
    config: HistoryTodayConfigT,
    ctx: DynamicContentFetchCtx
  ): Promise<HistoryTodayProviderData> {
    if (config.source === 'baidu_baike') {
      return await this.fetchBaiduBaike(config, ctx);
    }
    const tz = config.tz;
    const { month, day } = datePartsInTz(ctx.now, tz);
    const rawKey = `${mmdd(month, day)}:${RAW_LANG}`;
    const aiKey = `${rawKey}:${this.ai.modelKey()}:${this.ai.historyTodayPromptVersion()}`;
    const nowMs = ctx.now.getTime();
    return this.resultFetcher.getOrFetch(aiKey, nowMs, CACHE_TTL_MS, () =>
      this.fetchOptimized(month, day, rawKey, nowMs)
    );
  }

  private async fetchBaiduBaike(
    config: HistoryTodayConfigT,
    ctx: DynamicContentFetchCtx
  ): Promise<HistoryTodayProviderData> {
    const parts = datePartsInTz(ctx.now, config.tz);
    const month = String(parts.month).padStart(2, '0');
    const day = String(parts.day).padStart(2, '0');
    const key = `baidu:${month}-${day}`;
    const nowMs = ctx.now.getTime();

    const url = `https://baike.baidu.com/cms/home/eventsOnHistory/${month}.json`;
    return this.resultFetcher.getOrFetch(key, nowMs, CACHE_TTL_MS, async () => {
      const json = await fetchJson<BaiduHistoryResponse>(`${url}?_=${nowMs}`, {
        timeoutMs: DEFAULT_PROVIDER_FETCH_TIMEOUT_MS,
      });
      const rawItems = json[month]?.[`${month}${day}`] ?? [];
      const data = parseHistoryTodayData({
        dateLabel: `${parts.month}月${parts.day}日`,
        items: rawItems
          .map((item) => ({
            year: normalizeHistoryYear(textOrEmpty(item.year)),
            display: normalizeDisplay(stripHtml(textOrEmpty(item.title || item.desc))),
          }))
          .filter((item): item is { year: string; display: string } => {
            return !!item.year && !!item.display;
          }),
      });
      if (!data) throw new Error('baidu history empty');
      return data;
    });
  }

  private async fetchOptimized(
    month: number,
    day: number,
    rawKey: string,
    nowMs: number
  ): Promise<HistoryTodayProviderData> {
    const cachedRaw = this.rawCache.get(rawKey);
    const events =
      cachedRaw && nowMs - cachedRaw.fetchedAt < CACHE_TTL_MS
        ? cachedRaw.events
        : await this.fetchRawEvents(month, day);
    if (!cachedRaw || nowMs - cachedRaw.fetchedAt >= CACHE_TTL_MS) {
      setBoundedCache(this.rawCache, rawKey, { events, fetchedAt: nowMs }, MAX_RAW_CACHE_ENTRIES);
    }
    const dateLabel = `${month}月${day}日`;
    const aiData = await this.ai.optimizeHistoryToday({
      dateLabel,
      events: events.map((event) => ({
        year: event.year,
        yearLabel: yearLabel(event.year),
        text: event.text,
        pages: event.pages?.slice(0, 3),
      })),
    });
    const normalized = aiData ? normalizeHistoryTodayAiData(aiData, dateLabel) : null;
    if (!normalized) {
      throw new Error('history_today AI 优化失败');
    }
    return normalized;
  }

  private async fetchRawEvents(month: number, day: number): Promise<HistoryTodayRawEvent[]> {
    const url = `https://zh.wikipedia.org/api/rest_v1/feed/onthisday/events/${month}/${day}?variant=zh-cn`;
    const json = await fetchJson<{
      events?: Array<{
        year?: number;
        text?: string;
        pages?: Array<{ title?: string; description?: string; extract?: string }>;
      }>;
    }>(url, {
      timeoutMs: DEFAULT_PROVIDER_FETCH_TIMEOUT_MS,
      userAgent: WIKIMEDIA_USER_AGENT,
    });
    const evs = json.events ?? [];
    return evs
      .filter(
        (
          event
        ): event is {
          year: number;
          text: string;
          pages?: Array<{ title?: string; description?: string; extract?: string }>;
        } => {
          return typeof event.year === 'number' && typeof event.text === 'string' && !!event.text;
        }
      )
      .map((event) => ({
        year: event.year,
        text: event.text,
        pages: Array.isArray(event.pages)
          ? event.pages
              .map((page) => ({
                title: textOrEmpty(page.title),
                description: textOrEmpty(page.description),
                extract: textOrEmpty(page.extract),
              }))
              .filter((page) => page.title || page.description || page.extract)
          : [],
      }));
  }
}

interface HistoryTodayRawEvent {
  year: number;
  text: string;
  pages?: Array<{ title: string; description?: string; extract?: string }>;
}

interface BaiduHistoryResponse {
  [month: string]: {
    [monthDay: string]: Array<{
      title?: string;
      desc?: string;
      year?: string;
    }>;
  };
}

function mmdd(month: number, day: number): string {
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function yearLabel(year: number): string {
  return year < 0 ? `前${Math.abs(year)}` : String(year);
}

export function normalizeHistoryTodayAiData(
  data: { dateLabel: string; items: Array<{ year: string; display: string }> },
  fallbackDateLabel: string
): HistoryTodayProviderData | null {
  const items = data.items
    .map((item) => ({
      year: normalizeHistoryYear(item.year),
      display: normalizeDisplay(item.display),
    }))
    .filter((item): item is { year: string; display: string } => {
      return !!item.year && !!item.display;
    });

  return parseHistoryTodayData({
    dateLabel: textOrEmpty(data.dateLabel) || fallbackDateLabel,
    items,
  });
}

function normalizeDisplay(value: string): string {
  return value
    .trim()
    .replace(/^[\d前公元\s]+年?\s*[·.。:：、-]\s*/, '')
    .replace(/[。；;]+$/g, '')
    .replace(/\s+/g, ' ');
}

function textOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
