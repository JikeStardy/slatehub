import { afterEach, describe, expect, it } from 'bun:test';
import type { AiService } from '../../ai/ai.service';
import { HistoryTodayProvider } from './history-today.provider';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('HistoryTodayProvider', () => {
  it('caches Baidu Baike data within the provider TTL', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({
        '05': {
          '0517': [
            { year: '2001年', title: '<b>事件二</b>。' },
            { year: '1999', desc: '事件一；' },
          ],
        },
      });
    }) as unknown as typeof fetch;

    const provider = new HistoryTodayProvider({} as AiService);
    const config = provider.validateConfig({
      type: 'history_today',
      tz: 'Asia/Shanghai',
      source: 'baidu_baike',
    });

    const first = await provider.fetchData(config, {
      now: new Date('2026-05-17T04:00:00.000Z'),
    });
    const second = await provider.fetchData(config, {
      now: new Date('2026-05-17T04:30:00.000Z'),
    });

    expect(calls).toBe(1);
    expect(second).toEqual(first);
    expect(first).toEqual({
      dateLabel: '5月17日',
      items: [
        { year: '2001', display: '事件二' },
        { year: '1999', display: '事件一' },
      ],
    });
  });

  it('deduplicates concurrent Wikipedia and AI optimization requests', async () => {
    let releaseFetch!: () => void;
    const blockedFetch = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let fetchCalls = 0;
    let aiCalls = 0;
    let userAgent: string | null = null;
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      fetchCalls += 1;
      userAgent = new Headers(init?.headers).get('User-Agent');
      await blockedFetch;
      return Response.json({
        events: [
          {
            year: 1999,
            text: '事件一',
            pages: [{ title: '页面一', description: '描述一', extract: '摘要一' }],
          },
        ],
      });
    }) as unknown as typeof fetch;

    const provider = new HistoryTodayProvider({
      modelKey: () => 'model-a',
      historyTodayPromptVersion: () => 'prompt-v1',
      optimizeHistoryToday: async () => {
        aiCalls += 1;
        return {
          dateLabel: '5月17日',
          items: [{ year: '1999', display: '事件一' }],
        };
      },
    } as unknown as AiService);
    const config = provider.validateConfig({
      type: 'history_today',
      tz: 'Asia/Shanghai',
      source: 'wikipedia',
    });
    const ctx = { now: new Date('2026-05-17T04:00:00.000Z') };

    const first = provider.fetchData(config, ctx);
    const second = provider.fetchData(config, ctx);
    releaseFetch();
    const [firstData, secondData] = await Promise.all([first, second]);

    expect(fetchCalls).toBe(1);
    expect(aiCalls).toBe(1);
    expect(userAgent).toBe(
      'SlateHub/0.2 (+https://github.com/JikeStardy/slatehub; history-today-provider)'
    );
    expect(userAgent).not.toContain(['qiujun8023', ['s', 'late'].join('')].join('/'));
    expect(secondData).toEqual(firstData);
    expect(firstData.items).toEqual([{ year: '1999', display: '事件一' }]);
  });
});
