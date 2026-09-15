import { afterEach, describe, expect, it } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { frameDescriptorForProfile } from 'shared';
import { api } from '@/lib/http';
import { frameQueryKey } from '@/features/simulator/lib/simulator-frame';
import { fetchFrameBytes } from '@/features/simulator/lib/simulator-api';
import { DownloadFeedback, FrameStrip, SimulatorStage } from './SimulatorPage';
import { simulatorStageState } from '@/features/simulator/lib/simulator-frame';
import { contentSummary, manifestFor } from '@/features/simulator/lib/simulator-test-fixtures';

const virtualFrame = frameDescriptorForProfile('virtual-mono-296x128');
const originalApiGet = api.get;

afterEach(() => {
  api.get = originalApiGet;
});

describe('Simulator accessible markup', () => {
  it('announces stage and download status with aria live regions', () => {
    const manifest = manifestFor([
      contentSummary({ id: 'pending', status: 'pending', frame: virtualFrame }),
    ]);
    const state = simulatorStageState({ manifest });
    const stage = renderToStaticMarkup(<SimulatorStage state={state} />);
    const feedback = renderToStaticMarkup(
      <DownloadFeedback
        state={{
          status: 'error',
          identity: 'group\nprofile\ncontent\netag',
          message: 'toBlob failed',
        }}
      />
    );

    expect(stage).toContain('role="status"');
    expect(stage).toContain('aria-live="polite"');
    expect(feedback).toContain('role="alert"');
    expect(feedback).toContain('toBlob failed');
  });

  it('renders non-ready strip status visibly and in aria-label with frame name', () => {
    const markup = renderToStaticMarkup(
      <FrameStrip
        contents={[contentSummary({ id: 'pending', status: 'pending', frameName: 'Weather' })]}
        selectedContentId={null}
        onSelect={() => undefined}
      />
    );

    expect(markup).toContain('aria-label="Weather · 正在生成此 Profile 的帧"');
    expect(markup).toContain('正在生成');
  });

  it('renders ready canvas with descriptor ratio preserving width constraint', () => {
    const content = contentSummary({ id: 'virtual', frame: virtualFrame });
    const markup = renderToStaticMarkup(
      <SimulatorStage
        state={simulatorStageState({
          manifest: manifestFor([content]),
          selectedContentId: content.id,
        })}
        data={{ bytes: new Uint8Array(4736), descriptor: virtualFrame }}
      />
    );

    expect(markup).toContain('width="296"');
    expect(markup).toContain('height="128"');
    expect(markup).toContain('width:min(100%, calc(72vh * 296 / 128))');
    expect(markup).toContain('height:auto');
  });

  it('turns malformed fetched raw bytes into frame-error instead of accepting short payloads', async () => {
    const content = contentSummary({ id: 'virtual', frame: virtualFrame });

    mockApiGet(new ArrayBuffer(4736));
    await expect(fetchFrameBytes(content, virtualFrame.profile_id)).resolves.toMatchObject({
      descriptor: virtualFrame,
    });

    mockApiGet(new ArrayBuffer(4735));
    await expect(fetchFrameBytes(content, virtualFrame.profile_id)).rejects.toThrow(
      'raw frame length mismatch'
    );

    const frameError = renderToStaticMarkup(
      <SimulatorStage
        state={simulatorStageState({
          manifest: manifestFor([content]),
          selectedContentId: content.id,
          frameError: true,
        })}
      />
    );
    expect(frameError).toContain('role="alert"');
    expect(frameError).toContain('Raw frame 加载失败');
  });

  it('puts malformed frame query into QueryClient error state', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const content = contentSummary({ id: 'virtual', frame: virtualFrame });
    const key = frameQueryKey(content.id, content.image_etag, virtualFrame.profile_id);
    mockApiGet(new ArrayBuffer(4735));

    await expect(
      qc.fetchQuery({
        queryKey: key,
        queryFn: () => fetchFrameBytes(content, virtualFrame.profile_id),
      })
    ).rejects.toThrow('raw frame length mismatch');

    expect(qc.getQueryState(key)?.status).toBe('error');
  });
});

function mockApiGet(data: ArrayBuffer) {
  api.get = (async () => ({ data, status: 200 }) as never) as typeof api.get;
}
