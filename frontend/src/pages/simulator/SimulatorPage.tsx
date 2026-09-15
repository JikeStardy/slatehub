import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Play, SkipBack, SkipForward, Square } from 'lucide-react';
import type { ContentSummaryT, ManifestResponseT } from 'shared';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Select, SelectItem } from '@/components/ui/Select';
import { Spinner } from '@/components/ui/Spinner';
import { API_PREFIX, api } from '@/lib/http';
import { useGroups } from '@/features/groups/query/group-queries';
import { DisplayProfileSelector } from '@/features/profiles/components/DisplayProfileSelector';
import { defaultDisplayProfileId } from '@/features/profiles/profile-environment';
import { compatibilityLabel } from '@/features/contents/lib/variant-status';
import {
  drawRawFrameToCanvas,
  rawFrameToPngBlob,
  type ValidatedRawFrame,
} from '@/features/simulator/lib/simulator-canvas';
import { fetchFrameBytes } from '@/features/simulator/lib/simulator-api';
import { simulatorStageCanvasStyle } from '@/features/simulator/lib/simulator-layout';
import {
  batchSnapshotEntries,
  downloadOperationIdentity,
  frameQueryKey,
  manifestConditionalHeaders,
  manifestQueryKey,
  resetDownloadStateForSelection,
  runSimulatorDownloadForIdentity,
  resolveSelectedContentId,
  resolveManifestResponse,
  runSimulatorDownload,
  selectedFrameFilename,
  simulatorStageState,
  stepContentId,
  type DownloadState,
} from '@/features/simulator/lib/simulator-frame';

export function SimulatorPage() {
  const groups = useGroups();
  const firstGroupId = groups.data?.[0]?.id ?? '';
  const [groupId, setGroupId] = useState('');
  const [profileId, setProfileId] = useState(defaultDisplayProfileId);
  const [selectedContentId, setSelectedContentId] = useState<string | null>(null);
  const [autoStep, setAutoStep] = useState(false);
  const [singleDownload, setSingleDownload] = useState<DownloadState>({ status: 'idle' });

  useEffect(() => {
    if (!groupId && firstGroupId) setGroupId(firstGroupId);
  }, [firstGroupId, groupId]);

  const manifest = useSimulatorManifest(groupId, profileId);
  const selectedId = useMemo(
    () => resolveSelectedContentId(manifest.data?.contents ?? [], selectedContentId),
    [manifest.data?.contents, selectedContentId]
  );
  const selectedContent = useMemo(
    () => manifest.data?.contents.find((content) => content.id === selectedId) ?? null,
    [manifest.data?.contents, selectedId]
  );
  const frame = useSimulatorFrame(selectedContent, profileId);
  const singleDownloadIdentityInput = useMemo(
    () =>
      manifest.data && selectedContent
        ? {
            groupId: manifest.data.group.id,
            profileId,
            contentId: selectedContent.id,
            imageEtag: selectedContent.image_etag,
          }
        : null,
    [manifest.data, profileId, selectedContent]
  );
  const singleDownloadIdentity = singleDownloadIdentityInput
    ? downloadOperationIdentity(singleDownloadIdentityInput)
    : null;
  const stageState = simulatorStageState({
    manifest: manifest.data,
    selectedContentId,
    manifestPending: manifest.isPending,
    manifestError: manifest.isError,
    framePending: frame.isPending,
    frameError: frame.isError,
  });

  useEffect(() => {
    if (selectedId !== selectedContentId) setSelectedContentId(selectedId);
  }, [selectedContentId, selectedId]);

  useEffect(() => {
    if (!autoStep || !manifest.data) return;
    const timer = window.setInterval(() => {
      setSelectedContentId((current) => stepContentId(manifest.data!.contents, current, 1));
    }, 2500);
    return () => window.clearInterval(timer);
  }, [autoStep, manifest.data]);

  useEffect(() => {
    setSingleDownload((current) => resetDownloadStateForSelection(current, singleDownloadIdentity));
  }, [singleDownloadIdentity]);

  return (
    <div>
      <PageHeader
        onBack={() => {
          window.history.back();
        }}
        icon={<Play size={24} />}
        title="设备模拟器"
        subtitle="读取真实 v2 manifest 与 raw frame，按描述符在 Canvas 上复现设备像素。"
      />

      <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.45fr)_340px]">
        <SimulatorStage state={stageState} data={frame.data} />

        <aside className="border border-ink bg-paper">
          <div className="border-b border-ink px-4 py-3">
            <p className="font-serif text-[20px] font-bold leading-tight">Bench Controls</p>
          </div>
          <div className="space-y-5 px-4 py-4">
            {groups.isPending ? (
              <Spinner label="加载内容组" />
            ) : groups.data && groups.data.length > 0 ? (
              <label className="block">
                <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.18em] text-stone">
                  Group
                </span>
                <Select value={groupId} onValueChange={setGroupId} aria-label="Group">
                  {groups.data.map((group) => (
                    <SelectItem key={group.id} value={group.id} hint={`${group.content_count}`}>
                      {group.name}
                    </SelectItem>
                  ))}
                </Select>
              </label>
            ) : (
              <EmptyState title="尚无内容组" hint="先创建一个内容组再打开模拟器。" />
            )}

            <DisplayProfileSelector value={profileId} onChange={setProfileId} />

            <FrameStrip
              contents={manifest.data?.contents ?? []}
              selectedContentId={selectedContentId}
              onSelect={setSelectedContentId}
            />

            <div className="grid grid-cols-4 border border-ink">
              <IconButton
                label="上一帧"
                onClick={() =>
                  setSelectedContentId((id) => stepContentId(manifest.data?.contents ?? [], id, -1))
                }
              >
                <SkipBack size={15} />
              </IconButton>
              <IconButton
                label="下一帧"
                onClick={() =>
                  setSelectedContentId((id) => stepContentId(manifest.data?.contents ?? [], id, 1))
                }
              >
                <SkipForward size={15} />
              </IconButton>
              <IconButton
                label={autoStep ? '停止' : '自动'}
                onClick={() => setAutoStep((value) => !value)}
              >
                {autoStep ? <Square size={15} /> : <Play size={15} />}
              </IconButton>
              <IconButton
                label="PNG"
                disabled={
                  !selectedContent ||
                  !frame.data ||
                  !singleDownloadIdentityInput ||
                  singleDownload.status === 'pending'
                }
                onClick={() => {
                  if (
                    manifest.data &&
                    selectedContent &&
                    frame.data &&
                    singleDownloadIdentityInput
                  ) {
                    void runSimulatorDownloadForIdentity(
                      setSingleDownload,
                      singleDownloadIdentityInput,
                      () =>
                        downloadPngFromRaw(
                          frame.data.bytes,
                          frame.data.descriptor,
                          selectedFrameFilename(manifest.data!, selectedContent)
                        )
                    );
                  }
                }}
              >
                <Download size={15} />
              </IconButton>
            </div>

            <SimulatorReadout
              manifest={manifest.data}
              content={stageState.content}
              rawByteLength={frame.data?.bytes.byteLength ?? null}
              state={stageState.message}
            />
            <DownloadFeedback state={singleDownload} />

            <BatchSnapshotButton manifest={manifest.data} />
          </div>
        </aside>
      </div>
    </div>
  );
}

function useSimulatorManifest(groupId: string, profileId: string) {
  const qc = useQueryClient();
  const queryKey = manifestQueryKey(groupId || undefined, profileId);
  return useQuery({
    queryKey,
    queryFn: async () => {
      const cached = qc.getQueryData<ManifestResponseT>(queryKey);
      const response = await api.get<ManifestResponseT>(
        `${API_PREFIX}/groups/${groupId}/manifest`,
        {
          headers: manifestConditionalHeaders(cached),
          params: { display_profile_id: profileId },
          validateStatus: (status) => status === 200 || status === 304,
        }
      );
      return resolveManifestResponse({
        status: response.status,
        data: response.data,
        cached,
      });
    },
    enabled: !!groupId,
  });
}

function useSimulatorFrame(content: ContentSummaryT | null, profileId: string) {
  return useQuery({
    queryKey: frameQueryKey(content?.id, content?.image_etag, profileId),
    queryFn: async () => fetchFrameBytes(content!, profileId),
    enabled: !!content && content.variant_status === 'ready' && !!content.image_etag,
    staleTime: Infinity,
  });
}

export function SimulatorStage({
  state,
  data,
}: {
  state: ReturnType<typeof simulatorStageState>;
  data?: ValidatedRawFrame;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const content = state.content;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !content || !data) return;
    drawRawFrameToCanvas(canvas, data.bytes, data.descriptor);
  }, [content, data]);

  const descriptor = content?.frame;
  return (
    <section
      className="min-h-[460px] border border-ink bg-cream"
      role={state.tone === 'error' || state.tone === 'frame-error' ? 'alert' : 'status'}
      aria-live={state.tone === 'error' || state.tone === 'frame-error' ? 'assertive' : 'polite'}
    >
      <div className="flex items-center justify-between border-b border-ink px-4 py-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone">
          {descriptor
            ? `${descriptor.profile_id} · ${descriptor.width}x${descriptor.height}`
            : 'No frame selected'}
        </p>
        <p className="font-serif text-[15px] text-ink">{content?.frame_name ?? '待机'}</p>
      </div>
      <div className="flex min-h-[410px] items-center justify-center p-4">
        {state.tone === 'ready' && content && data ? (
          <canvas
            ref={canvasRef}
            width={content.frame.width}
            height={content.frame.height}
            className="block max-w-full border border-ink bg-paper"
            style={simulatorStageCanvasStyle(content.frame)}
          />
        ) : state.tone === 'loading' || state.tone === 'frame-loading' ? (
          <Spinner label={state.message} />
        ) : (
          <div className="max-w-sm border border-ink bg-paper px-5 py-4 text-center">
            <p className="font-serif text-[18px] font-bold text-ink">{state.message}</p>
            {content && (
              <p className="mt-2 font-sans text-[12px] text-stone">
                {compatibilityLabel(content.variant_status)} · {content.frame.profile_id}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export function FrameStrip({
  contents,
  selectedContentId,
  onSelect,
}: {
  contents: ContentSummaryT[];
  selectedContentId: string | null;
  onSelect: (contentId: string) => void;
}) {
  if (contents.length === 0) {
    return (
      <p className="border border-line px-3 py-2 font-sans text-[12px] text-stone">Manifest 为空</p>
    );
  }
  return (
    <div>
      <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.18em] text-stone">
        Frame Strip
      </p>
      <div className="flex gap-1 overflow-x-auto border border-ink p-1">
        {contents.map((content) => {
          const statusLabel = compatibilityLabel(content.variant_status);
          return (
            <button
              key={content.id}
              type="button"
              disabled={content.variant_status !== 'ready'}
              onClick={() => onSelect(content.id)}
              aria-label={`${content.frame_name} · ${statusLabel}`}
              title={statusLabel}
              className={`min-h-8 min-w-16 border px-2 py-1 font-mono text-[11px] ${
                content.id === selectedContentId
                  ? 'border-ink bg-ink text-paper'
                  : 'border-line text-stone hover:bg-cream-deep'
              } disabled:opacity-40`}
            >
              <span className="block">{String(content.seq + 1).padStart(2, '0')}</span>
              <span className="block max-w-20 truncate text-[9px] leading-tight">
                {content.variant_status === 'ready'
                  ? '就绪'
                  : content.variant_status === 'pending'
                    ? '正在生成'
                    : content.variant_status === 'failed'
                      ? '失败'
                      : '不可用'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SimulatorReadout({
  manifest,
  content,
  rawByteLength,
  state,
}: {
  manifest?: ManifestResponseT;
  content: ContentSummaryT | null;
  rawByteLength: number | null;
  state: string;
}) {
  const rows = [
    ['profile', manifest?.display_profile.id ?? '—'],
    ['codec', content?.frame.frame_codec ?? '—'],
    ['pixel', content?.frame.pixel_format ?? '—'],
    ['dimensions', content ? `${content.frame.width}x${content.frame.height}` : '—'],
    ['bytes', rawByteLength != null ? `${rawByteLength}` : '—'],
    ['frame etag', content?.image_etag || '—'],
    ['content etag', content?.content_etag ?? '—'],
    ['manifest etag', manifest?.group.manifest_etag ?? '—'],
    ['state', state],
  ];

  return (
    <dl className="border border-ink font-mono text-[11px]">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="grid grid-cols-[108px_minmax(0,1fr)] border-b border-line last:border-b-0"
        >
          <dt className="bg-cream-deep px-2 py-1 text-stone">{label}</dt>
          <dd className="truncate px-2 py-1 text-ink" title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function BatchSnapshotButton({ manifest }: { manifest?: ManifestResponseT }) {
  const qc = useQueryClient();
  const [download, setDownload] = useState<DownloadState>({ status: 'idle' });
  const readyContents =
    manifest?.contents.filter((content) => content.variant_status === 'ready') ?? [];
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        fullWidth
        disabled={!manifest || readyContents.length === 0 || download.status === 'pending'}
        iconLeft={<Download size={14} />}
        onClick={() => {
          if (!manifest) return;
          void runSimulatorDownload(setDownload, async () => {
            const rawByContentId = new Map<string, Uint8Array>();
            await Promise.all(
              readyContents.map(async (content) => {
                const raw = await qc.fetchQuery({
                  queryKey: frameQueryKey(content.id, content.image_etag, content.frame.profile_id),
                  queryFn: () => fetchFrameBytes(content, content.frame.profile_id),
                  staleTime: Infinity,
                });
                rawByContentId.set(content.id, raw.bytes);
              })
            );
            await Promise.all(
              batchSnapshotEntries(manifest, rawByContentId).map((entry) =>
                downloadPngFromRaw(entry.bytes, entry.descriptor, entry.filename)
              )
            );
          });
        }}
      >
        {download.status === 'pending' ? '导出中' : '批量快照'}
      </Button>
      <DownloadFeedback state={download} />
    </>
  );
}

export function DownloadFeedback({ state }: { state: DownloadState }) {
  if (state.status === 'idle') return null;
  return (
    <p
      className={`font-sans text-[12px] ${state.status === 'error' ? 'text-clay' : 'text-stone'}`}
      role={state.status === 'error' ? 'alert' : 'status'}
      aria-live={state.status === 'error' ? 'assertive' : 'polite'}
    >
      {state.status === 'pending'
        ? '正在导出 PNG'
        : state.status === 'success'
          ? 'PNG 已生成'
          : state.message}
    </p>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-10 items-center justify-center border-r border-ink last:border-r-0 hover:bg-cream-deep disabled:opacity-40"
    >
      {children}
    </button>
  );
}

async function downloadPngFromRaw(
  bytes: Uint8Array,
  descriptor: ContentSummaryT['frame'],
  filename: string
): Promise<void> {
  const canvas = document.createElement('canvas');
  const blob = await rawFrameToPngBlob(canvas, bytes, descriptor);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
