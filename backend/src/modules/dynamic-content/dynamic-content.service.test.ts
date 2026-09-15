import { describe, expect, it } from 'bun:test';
import { ValidationError } from '../../common/errors';
import { DynamicContentService } from './dynamic-content.service';

describe('DynamicContentService display profile guard', () => {
  it('rejects a virtual profile before attempting preview rendering', async () => {
    const service = new DynamicContentService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    await expect(
      service.previewDirect({
        config: { type: 'daily_calendar', tz: 'Asia/Shanghai' },
        display_profile_id: 'virtual-mono-296x128',
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
