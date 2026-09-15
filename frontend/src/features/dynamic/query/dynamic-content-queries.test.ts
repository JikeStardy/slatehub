import { describe, expect, it } from 'bun:test';
import type { DynamicConfigT } from 'shared';
import { buildDynamicPreviewBody } from './dynamic-content-queries';

describe('dynamic preview request body', () => {
  it('carries the selected display_profile_id', () => {
    const config: DynamicConfigT = {
      type: 'font_test',
      font_id: 'fusion_pixel_10',
      invert: false,
    };

    expect(
      buildDynamicPreviewBody({
        config,
        displayProfileId: 'virtual-mono-296x128',
        frameName: 'Virtual',
      })
    ).toMatchObject({
      config,
      display_profile_id: 'virtual-mono-296x128',
      frame_name: 'Virtual',
    });
  });
});
