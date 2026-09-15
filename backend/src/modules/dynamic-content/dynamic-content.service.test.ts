import { describe, expect, it } from 'bun:test';
import { DynamicContentService } from './dynamic-content.service';

describe('DynamicContentService display profile guard', () => {
  it('passes a virtual profile through to direct preview rendering', async () => {
    const calls: string[] = [];
    const service = new DynamicContentService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        renderPreviewDirect: async (
          _dynamicType: string,
          _config: unknown,
          _frameName: string | null,
          _data: unknown,
          displayProfileId: string
        ) => {
          calls.push(displayProfileId);
          return Buffer.alloc(4_736);
        },
      } as never
    );

    await expect(
      service.previewDirect({
        config: { type: 'daily_calendar', tz: 'Asia/Shanghai' },
        display_profile_id: 'virtual-mono-296x128',
      })
    ).resolves.toHaveLength(4_736);
    expect(calls).toEqual(['virtual-mono-296x128']);
  });
});
