import { describe, expect, it } from 'bun:test';
import { frameDescriptorForProfile, type ContentSummaryT, type ManifestResponseT } from 'shared';
import {
  batchSnapshotEntries,
  beginDownloadOperation,
  completeDownloadOperation,
  downloadOperationIdentity,
  manifestConditionalHeaders,
  resetDownloadStateForSelection,
  resolveManifestResponse,
  runSimulatorDownload,
  runSimulatorDownloadForIdentity,
  simulatorStageState,
  stepContentId,
  frameQueryKey,
  manifestQueryKey,
  resolveSelectedContentId,
  selectedFrameFilename,
  simulatorProfileIds,
  type DownloadState,
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

  it('models simulator loading, empty, non-ready and frame-error states distinctly', () => {
    expect(simulatorStageState({ manifestPending: true })).toMatchObject({ tone: 'loading' });
    expect(simulatorStageState({ manifestError: true })).toMatchObject({ tone: 'error' });
    expect(simulatorStageState({ manifest: manifestFor([]) })).toMatchObject({ tone: 'empty' });
    expect(
      simulatorStageState({
        manifest: manifestFor([content({ id: 'pending', status: 'pending', frame: virtualFrame })]),
      })
    ).toMatchObject({ tone: 'non-ready' });
    expect(
      simulatorStageState({
        manifest: manifestFor([content({ id: 'ready', frame: virtualFrame })]),
        selectedContentId: 'ready',
        framePending: true,
      })
    ).toMatchObject({ tone: 'frame-loading' });
    expect(
      simulatorStageState({
        manifest: manifestFor([content({ id: 'ready', frame: virtualFrame })]),
        selectedContentId: 'ready',
        frameError: true,
      })
    ).toMatchObject({ tone: 'frame-error' });
  });

  it('steps previous, next and auto over ready frames only', () => {
    const contents = [
      content({ id: 'ready-a', seq: 0 }),
      content({ id: 'failed', seq: 1, status: 'failed' }),
      content({ id: 'ready-b', seq: 2 }),
    ];

    expect(stepContentId(contents, 'ready-a', 1)).toBe('ready-b');
    expect(stepContentId(contents, 'ready-b', 1)).toBe('ready-a');
    expect(stepContentId(contents, 'ready-a', -1)).toBe('ready-b');
  });

  it('reuses the cached manifest body on 304 and keeps selection deterministic', () => {
    const cached = manifestFor([
      content({ id: 'ready-a', seq: 0, frame: virtualFrame }),
      content({ id: 'ready-b', seq: 1, frame: virtualFrame }),
    ]);

    expect(manifestConditionalHeaders(cached)).toEqual({
      'If-None-Match': 'manifest-virtual',
    });
    const reused = resolveManifestResponse({ status: 304, data: undefined, cached });

    expect(reused).toBe(cached);
    expect(resolveSelectedContentId(reused.contents, 'missing')).toBe('ready-a');
  });

  it('reports download errors instead of failing silently', async () => {
    const states: unknown[] = [];

    await runSimulatorDownload(
      (state) => states.push(state),
      async () => {
        throw new Error('toBlob failed');
      }
    );

    expect(states).toEqual([
      { status: 'pending', identity: 'default' },
      { status: 'error', identity: 'default', message: 'toBlob failed' },
    ]);
  });

  it('ignores stale download completion after the selected operation identity changes', () => {
    const first = beginDownloadOperation({
      groupId: 'group-1',
      profileId: virtualFrame.profile_id,
      contentId: 'content-1',
      imageEtag: 'etag-1',
    });
    const second = beginDownloadOperation({
      groupId: 'group-1',
      profileId: note4Frame.profile_id,
      contentId: 'content-2',
      imageEtag: 'etag-2',
    });

    expect(completeDownloadOperation(second, first.identity, { ok: true })).toBe(second);
    expect(completeDownloadOperation(second, second.identity, { ok: true })).toMatchObject({
      status: 'success',
    });
  });

  it('keeps pending download identity while ignoring stale deferred completions', async () => {
    const first = deferred<void>();
    const states: DownloadState[] = [];
    let current: DownloadState = { status: 'idle' };
    const setDownload = (update: DownloadState | ((state: DownloadState) => DownloadState)) => {
      current = typeof update === 'function' ? update(current) : update;
      states.push(current);
    };

    const firstRun = runSimulatorDownloadForIdentity(
      setDownload,
      {
        groupId: 'group-1',
        profileId: virtualFrame.profile_id,
        contentId: 'content-1',
        imageEtag: 'etag-1',
      },
      () => first.promise
    );
    expect(current).toMatchObject({ status: 'pending' });

    current = beginDownloadOperation({
      groupId: 'group-1',
      profileId: virtualFrame.profile_id,
      contentId: 'content-2',
      imageEtag: 'etag-2',
    });
    first.resolve();
    await firstRun;

    expect(current).toMatchObject({ status: 'pending', identity: current.identity });
    expect(states.at(-1)).toBe(current);
  });

  it('resets visible download state when the selected identity changes', () => {
    const pending = beginDownloadOperation({
      groupId: 'group-1',
      profileId: virtualFrame.profile_id,
      contentId: 'content-1',
      imageEtag: 'etag-1',
    });
    const same = downloadOperationIdentity({
      groupId: 'group-1',
      profileId: virtualFrame.profile_id,
      contentId: 'content-1',
      imageEtag: 'etag-1',
    });
    const next = downloadOperationIdentity({
      groupId: 'group-1',
      profileId: virtualFrame.profile_id,
      contentId: 'content-2',
      imageEtag: 'etag-2',
    });

    expect(resetDownloadStateForSelection(pending, same)).toBe(pending);
    expect(resetDownloadStateForSelection(pending, next)).toEqual({ status: 'idle' });
    expect(resetDownloadStateForSelection(pending, null)).toEqual({ status: 'idle' });
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
