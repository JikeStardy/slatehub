import { frameDescriptorForProfile, type ContentSummaryT, type ManifestResponseT } from 'shared';

export function manifestFor(contents: ContentSummaryT[]): ManifestResponseT {
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

export function contentSummary({
  id,
  seq = 0,
  status = 'ready',
  imageEtag = 'etag',
  frame = frameDescriptorForProfile('zectrix-note4-400x300-mono'),
  frameName = id,
}: {
  id: string;
  seq?: number;
  status?: ContentSummaryT['variant_status'];
  imageEtag?: string;
  frame?: ContentSummaryT['frame'];
  frameName?: string;
}): ContentSummaryT {
  return {
    id,
    seq,
    content_etag: `content-${imageEtag}`,
    frame_name: frameName,
    device_status_bar_text: frameName,
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
