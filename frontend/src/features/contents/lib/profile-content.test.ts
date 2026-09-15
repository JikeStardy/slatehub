import { describe, expect, it } from 'bun:test';
import { frameDescriptorForProfile, type ContentDetailT } from 'shared';
import { pendingContentForProfile } from './profile-content';

describe('profile-specific content fallback', () => {
  it('uses the requested descriptor while profile detail is loading', () => {
    const content = contentDetail();
    const pending = pendingContentForProfile(content, 'virtual-mono-296x128');

    expect(pending.variant_status).toBe('pending');
    expect(pending.image_etag).toBe('');
    expect(pending.frame).toEqual(frameDescriptorForProfile('virtual-mono-296x128'));
  });
});

function contentDetail(): ContentDetailT {
  const frame = frameDescriptorForProfile('zectrix-note4-400x300-mono');
  return {
    id: 'content-1',
    group_id: 'group-1',
    seq: 0,
    content_etag: 'content-note4',
    frame_name: 'Frame',
    device_status_bar_text: 'Frame',
    image_etag: 'etag-note4',
    audio_etag: null,
    image_size: frame.byte_length,
    variant_status: 'ready',
    audio_size: null,
    audio_status: 'none',
    audio_source: null,
    audio_voice: null,
    kind: 'image',
    dynamic_type: null,
    next_wake_sec: null,
    dynamic_next_run_at: null,
    dynamic_refresh_due_at: null,
    frame,
    dynamic_config: null,
    dynamic_data: null,
    dynamic_last_rendered_at: null,
    dynamic_next_render_at: null,
    dynamic_render_error: null,
    audio_text: null,
    audio_error: null,
    audio_updated_at: null,
  };
}
