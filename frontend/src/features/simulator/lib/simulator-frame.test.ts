import { describe, expect, it } from 'bun:test';
import { frameDescriptorForProfile, type ContentSummaryT, type ManifestResponseT } from 'shared';
import {
  batchSnapshotEntries,
  frameQueryKey,
  manifestQueryKey,
  resolveSelectedContentId,
  selectedFrameFilename,
  simulatorProfileIds,
} from './simulator-frame';

const note4Frame = frameDescriptorForProfile('zectrix-note4-400x300-mono');
const virtualFrame = frameDescriptorForProfile('virtual-mono-296x128');

describe('simulator profile cache and selection helpers', () => {
  it('isolates manifest and frame cache keys by group, profile, etag and identity', () => {
    expect(manifestQueryKey('group-1', note4Frame.profile_id)).not.toEqual(
      manifestQueryKey('group-1', virtualFrame.profile_id)
    );
    expect(frameQueryKey('content-1', 'etag-a', note4Frame.profile_id)).not.toEqual(
      frameQueryKey('content-1', 'etag-a', virtualFrame.profile_id)
    );
    expect(frameQueryKey('content-1', 'etag-a', note4Frame.profile_id)).not.toEqual(
      frameQueryKey('content-1', 'etag-b', note4Frame.profile_id)
    );
  });

  it('exposes virtual simulator profiles only outside production', () => {
    expect(simulatorProfileIds('production')).toEqual(['zectrix-note4-400x300-mono']);
    expect(simulatorProfileIds('development')).toEqual([
      'zectrix-note4-400x300-mono',
      'virtual-mono-296x128',
    ]);
    expect(simulatorProfileIds('test')).toEqual([
      'zectrix-note4-400x300-mono',
      'virtual-mono-296x128',
    ]);
  });

  it('deterministically resolves invalidated selections to the first ready entry', () => {
    const contents = [
      content({ id: 'pending', seq: 0, status: 'pending' }),
      content({ id: 'ready-a', seq: 1, status: 'ready' }),
      content({ id: 'ready-b', seq: 2, status: 'ready' }),
    ];

    expect(resolveSelectedContentId(contents, 'missing')).toBe('ready-a');
    expect(resolveSelectedContentId(contents, 'ready-b')).toBe('ready-b');
    expect(resolveSelectedContentId([content({ id: 'failed', status: 'failed' })], 'missing')).toBe(
      null
    );
  });

  it('builds PNG filenames and batch snapshots from ready fetched raw bytes only', () => {
    const ready = content({
      id: 'content-1',
      seq: 3,
      imageEtag: 'etag-ready',
      frame: virtualFrame,
    });
    const failed = content({ id: 'content-2', seq: 4, status: 'failed', frame: virtualFrame });
    const manifest = manifestFor([ready, failed]);
    const rawByContentId = new Map([['content-1', new Uint8Array(virtualFrame.byte_length)]]);

    expect(selectedFrameFilename(manifest, ready)).toBe(
      'slate-group-1-04-content-1-virtual-mono-296x128-etag-ready.png'
    );
    const readyBytes = rawByContentId.get('content-1');
    expect(readyBytes).toBeDefined();
    expect(batchSnapshotEntries(manifest, rawByContentId)).toEqual([
      {
        contentId: 'content-1',
        filename: 'slate-group-1-04-content-1-virtual-mono-296x128-etag-ready.png',
        bytes: readyBytes!,
        descriptor: virtualFrame,
      },
    ]);
  });
});

function manifestFor(contents: ContentSummaryT[]): ManifestResponseT {
  return {
    group: {
      id: 'group-1',
      name: 'Lab',
      structure_etag: 'structure',
      manifest_etag: 'manifest-virtual',
      sort_order: 0,
      position: { current: 1, total: 1 },
    },
    display_profile: {
      id: 'virtual-mono-296x128',
      width: 296,
      height: 128,
      pixel_format: 'mono1',
      frame_codec: 'raw_mono1_msb',
      availability: ['development', 'test'],
    },
    contents,
  };
}

function content({
  id,
  seq = 0,
  status = 'ready',
  imageEtag = 'etag',
  frame = note4Frame,
}: {
  id: string;
  seq?: number;
  status?: ContentSummaryT['variant_status'];
  imageEtag?: string;
  frame?: ContentSummaryT['frame'];
}): ContentSummaryT {
  return {
    id,
    seq,
    content_etag: `content-${imageEtag}`,
    frame_name: id,
    device_status_bar_text: id,
    image_etag: status === 'ready' ? imageEtag : '',
    audio_etag: null,
    image_size: status === 'ready' ? frame.byte_length : 0,
    variant_status: status,
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
  };
}
