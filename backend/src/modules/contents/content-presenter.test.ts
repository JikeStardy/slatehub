import { describe, expect, it } from 'bun:test';
import { etagMatches } from '../../common/utils/etag';
import {
  contentFrameResourceEtag,
  contentSummaryEtag,
  manifestReadEtag,
  MIN_DYNAMIC_WAKE_SEC,
  nextWakeSec,
} from './content-presenter';

describe('nextWakeSec', () => {
  const now = new Date('2026-01-01T00:00:00.000Z').getTime();

  it('returns null for static frames (no nextRunAt)', () => {
    expect(nextWakeSec(null, now)).toBeNull();
  });

  it('returns remaining seconds for a future refresh', () => {
    expect(nextWakeSec(new Date(now + 3600_000), now)).toBe(3600);
  });

  it('floors a due / overdue dynamic frame to the minimum instead of 0', () => {
    expect(nextWakeSec(new Date(now), now)).toBe(MIN_DYNAMIC_WAKE_SEC);
    expect(nextWakeSec(new Date(now - 10_000), now)).toBe(MIN_DYNAMIC_WAKE_SEC);
  });

  it('floors a sub-minimum positive interval to the minimum', () => {
    expect(nextWakeSec(new Date(now + 5_000), now)).toBe(MIN_DYNAMIC_WAKE_SEC);
  });
});

describe('profile-scoped read ETags', () => {
  it('keeps frame, content, and manifest validators isolated by profile', () => {
    const frameEtag = 'same-frame-digest';
    const note4Frame = contentFrameResourceEtag('zectrix-note4-400x300-mono', frameEtag);
    const virtualFrame = contentFrameResourceEtag('virtual-mono-296x128', frameEtag);
    const note4Content = contentSummaryEtag('zectrix-note4-400x300-mono', frameEtag);
    const virtualContent = contentSummaryEtag('virtual-mono-296x128', frameEtag);

    expect(note4Frame).not.toBe(virtualFrame);
    expect(note4Content).not.toBe(virtualContent);
    expect(etagMatches(`"${note4Frame}"`, virtualFrame)).toBe(false);

    const note4Manifest = manifestReadEtag({
      profileId: 'zectrix-note4-400x300-mono',
      groupStructureEtag: 'structure',
      contents: [],
    });
    const virtualManifest = manifestReadEtag({
      profileId: 'virtual-mono-296x128',
      groupStructureEtag: 'structure',
      contents: [],
    });

    expect(note4Manifest).not.toBe(virtualManifest);
    expect(etagMatches(`"${note4Manifest}"`, virtualManifest)).toBe(false);
  });

  it('keeps the same manifest validator for the same database schedule snapshot as countdown changes', () => {
    const first = manifestReadEtag({
      profileId: 'zectrix-note4-400x300-mono',
      group: {
        id: 'group-1',
        name: 'Kitchen',
        sort_order: 2,
        position: { current: 1, total: 3 },
      },
      groupStructureEtag: 'structure',
      contents: [
        {
          id: 'content-1',
          seq: 0,
          content_etag: 'content-note4',
          frame_name: 'Morning',
          device_status_bar_text: 'Weather · Sunny',
          image_etag: 'image-note4',
          audio_etag: 'audio-1',
          image_size: 15_000,
          audio_size: 320,
          variant_status: 'ready',
          audio_status: 'ready',
          audio_source: 'tts',
          audio_voice: 'alloy',
          kind: 'dynamic',
          dynamic_type: 'weather',
          next_wake_sec: 3600,
          dynamic_next_run_at: '2026-01-01T01:00:00.000Z',
          dynamic_refresh_due_at: '2026-01-01T01:00:00.000Z',
          frame: {
            profile_id: 'zectrix-note4-400x300-mono',
            width: 400,
            height: 300,
            pixel_format: 'mono1',
            frame_codec: 'raw_mono1_msb',
            byte_length: 15_000,
          },
        },
      ],
    });
    const second = manifestReadEtag({
      profileId: 'zectrix-note4-400x300-mono',
      group: {
        id: 'group-1',
        name: 'Kitchen',
        sort_order: 2,
        position: { current: 1, total: 3 },
      },
      groupStructureEtag: 'structure',
      contents: [
        {
          id: 'content-1',
          seq: 0,
          content_etag: 'content-note4',
          frame_name: 'Morning',
          device_status_bar_text: 'Weather · Sunny',
          image_etag: 'image-note4',
          audio_etag: 'audio-1',
          image_size: 15_000,
          audio_size: 320,
          variant_status: 'ready',
          audio_status: 'ready',
          audio_source: 'tts',
          audio_voice: 'alloy',
          kind: 'dynamic',
          dynamic_type: 'weather',
          next_wake_sec: 3599,
          dynamic_next_run_at: '2026-01-01T01:00:00.000Z',
          dynamic_refresh_due_at: '2026-01-01T01:00:00.000Z',
          frame: {
            profile_id: 'zectrix-note4-400x300-mono',
            width: 400,
            height: 300,
            pixel_format: 'mono1',
            frame_codec: 'raw_mono1_msb',
            byte_length: 15_000,
          },
        },
      ],
    });

    expect(second).toBe(first);
  });

  it('changes the manifest validator when visible stable group or content fields change', () => {
    const base = {
      profileId: 'zectrix-note4-400x300-mono',
      group: {
        id: 'group-1',
        name: 'Kitchen',
        sort_order: 2,
        position: { current: 1, total: 3 },
      },
      groupStructureEtag: 'structure',
      contents: [
        {
          id: 'content-1',
          seq: 0,
          content_etag: 'content-note4',
          frame_name: 'Morning',
          device_status_bar_text: 'Weather · Sunny',
          image_etag: 'image-note4',
          audio_etag: null,
          image_size: 15_000,
          audio_size: null,
          variant_status: 'ready' as const,
          audio_status: 'none' as const,
          audio_source: null,
          audio_voice: null,
          kind: 'image' as const,
          dynamic_type: null,
          next_wake_sec: null,
          dynamic_next_run_at: null,
          dynamic_refresh_due_at: null,
          frame: {
            profile_id: 'zectrix-note4-400x300-mono',
            width: 400,
            height: 300,
            pixel_format: 'mono1' as const,
            frame_codec: 'raw_mono1_msb' as const,
            byte_length: 15_000,
          },
        },
      ],
    };
    const etag = manifestReadEtag(base);

    expect(manifestReadEtag({ ...base, group: { ...base.group, name: 'Desk' } })).not.toBe(etag);
    expect(
      manifestReadEtag({
        ...base,
        contents: [{ ...base.contents[0]!, frame_name: 'Evening' }],
      })
    ).not.toBe(etag);
    expect(
      manifestReadEtag({
        ...base,
        contents: [{ ...base.contents[0]!, device_status_bar_text: 'Weather · Rain' }],
      })
    ).not.toBe(etag);
  });

  it('uses unambiguous canonical serialization for manifest fields that contain separators', () => {
    const base = {
      profileId: 'zectrix-note4-400x300-mono',
      group: {
        id: 'group-1',
        name: 'Group',
        sort_order: 0,
        position: { current: 1, total: 1 },
      },
      groupStructureEtag: 'structure',
      contents: [
        {
          id: 'content-1',
          seq: 0,
          content_etag: 'content',
          frame_name: 'a:b',
          device_status_bar_text: 'c',
          image_etag: 'image',
          audio_etag: null,
          image_size: 15_000,
          audio_size: null,
          variant_status: 'ready' as const,
          audio_status: 'none' as const,
          audio_source: null,
          audio_voice: null,
          kind: 'image' as const,
          dynamic_type: null,
          next_wake_sec: null,
          dynamic_next_run_at: null,
          dynamic_refresh_due_at: null,
          frame: {
            profile_id: 'zectrix-note4-400x300-mono',
            width: 400,
            height: 300,
            pixel_format: 'mono1' as const,
            frame_codec: 'raw_mono1_msb' as const,
            byte_length: 15_000,
          },
        },
      ],
    };
    const separatorAmbiguous = {
      ...base,
      contents: [
        {
          ...base.contents[0]!,
          frame_name: 'a',
          device_status_bar_text: 'b:c',
        },
      ],
    };

    expect(manifestReadEtag(separatorAmbiguous)).not.toBe(manifestReadEtag(base));
  });
});
