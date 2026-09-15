import { describe, expect, it } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { frameDescriptorForProfile, type ContentDetailT } from 'shared';
import {
  applyOptimisticContentOrder,
  invalidateContentDependencies,
} from './content-cache-helpers';
import { contentKeys } from './keys';

describe('profile-aware content query cache', () => {
  it('invalidates every profile list/detail and removes every profile image for a content', async () => {
    const qc = new QueryClient();
    qc.setQueryData(contentKeys.group('group-1', 'zectrix-note4-400x300-mono'), [content('a')]);
    qc.setQueryData(contentKeys.group('group-1', 'virtual-mono-296x128'), [content('a')]);
    qc.setQueryData(contentKeys.detail('a', 'zectrix-note4-400x300-mono'), content('a'));
    qc.setQueryData(contentKeys.detail('a', 'virtual-mono-296x128'), content('a'));
    qc.setQueryData(
      contentKeys.image('a', 'etag-a', 'zectrix-note4-400x300-mono'),
      new ArrayBuffer(1)
    );
    qc.setQueryData(contentKeys.image('a', 'etag-b', 'virtual-mono-296x128'), new ArrayBuffer(1));

    await invalidateContentDependencies(qc, 'group-1', 'a');

    expect(qc.getQueryCache().findAll({ queryKey: contentKeys.groupRoot('group-1') })).toHaveLength(
      2
    );
    expect(
      qc
        .getQueryCache()
        .findAll({ queryKey: contentKeys.groupRoot('group-1') })
        .every((query) => query.isStale())
    ).toBe(true);
    expect(qc.getQueryCache().findAll({ queryKey: contentKeys.detailRoot('a') })).toHaveLength(2);
    expect(qc.getQueryCache().findAll({ queryKey: contentKeys.imageRoot('a') })).toHaveLength(0);
  });

  it('optimistic reorder updates only the current profile key', () => {
    const note4Key = contentKeys.group('group-1', 'zectrix-note4-400x300-mono');
    const virtualKey = contentKeys.group('group-1', 'virtual-mono-296x128');
    const qc = new QueryClient();
    qc.setQueryData(note4Key, [content('a'), content('b')]);
    qc.setQueryData(virtualKey, [content('a'), content('b')]);

    applyOptimisticContentOrder(qc, note4Key, ['b', 'a']);

    expect(qc.getQueryData<ContentDetailT[]>(note4Key)?.map((item) => item.id)).toEqual(['b', 'a']);
    expect(qc.getQueryData<ContentDetailT[]>(virtualKey)?.map((item) => item.id)).toEqual([
      'a',
      'b',
    ]);
  });
});

function content(id: string): ContentDetailT {
  const frame = frameDescriptorForProfile('zectrix-note4-400x300-mono');
  return {
    id,
    group_id: 'group-1',
    seq: id === 'a' ? 0 : 1,
    content_etag: `content-${id}`,
    frame_name: id,
    device_status_bar_text: id,
    image_etag: `etag-${id}`,
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
