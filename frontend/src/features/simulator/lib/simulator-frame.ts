import {
  displayProfilesForEnvironment,
  type ContentSummaryT,
  type DisplayProfileEnvironmentT,
  type FrameDescriptorT,
  type ManifestResponseT,
} from 'shared';

export interface BatchSnapshotEntry {
  contentId: string;
  filename: string;
  bytes: Uint8Array;
  descriptor: FrameDescriptorT;
}

export type SimulatorStageTone =
  | 'loading'
  | 'error'
  | 'empty'
  | 'non-ready'
  | 'frame-loading'
  | 'frame-error'
  | 'ready';

export interface SimulatorStageState {
  tone: SimulatorStageTone;
  message: string;
  content: ContentSummaryT | null;
}

export type DownloadState =
  | { status: 'idle' }
  | { status: 'pending'; identity: string }
  | { status: 'success'; identity: string }
  | { status: 'error'; identity: string; message: string };
type PendingDownloadState = Extract<DownloadState, { status: 'pending' }>;

export interface DownloadOperationIdentityInput {
  groupId: string;
  profileId: string;
  contentId: string;
  imageEtag: string;
}

export function manifestQueryKey(groupId: string | undefined, profileId: string) {
  return ['simulator', 'manifest', groupId, profileId] as const;
}

export function frameQueryKey(
  contentId: string | undefined,
  imageEtag: string | undefined | null,
  profileId: string
) {
  return ['simulator', 'frame', contentId, profileId, imageEtag ?? null] as const;
}

export function simulatorProfileIds(environment: DisplayProfileEnvironmentT): string[] {
  return displayProfilesForEnvironment(environment).map((profile) => profile.id);
}

export function resolveSelectedContentId(
  contents: readonly ContentSummaryT[],
  selectedContentId: string | null
): string | null {
  if (
    selectedContentId &&
    contents.some(
      (content) => content.id === selectedContentId && content.variant_status === 'ready'
    )
  ) {
    return selectedContentId;
  }
  return contents.find((content) => content.variant_status === 'ready')?.id ?? null;
}

export function stepContentId(
  contents: readonly ContentSummaryT[],
  currentId: string | null,
  direction: 1 | -1
): string | null {
  const ready = contents.filter((content) => content.variant_status === 'ready');
  if (ready.length === 0) return null;
  const currentIndex = ready.findIndex((content) => content.id === currentId);
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + direction + ready.length) % ready.length;
  return ready[nextIndex]!.id;
}

export function simulatorStageState({
  manifest,
  selectedContentId = null,
  manifestPending = false,
  manifestError = false,
  framePending = false,
  frameError = false,
}: {
  manifest?: ManifestResponseT;
  selectedContentId?: string | null;
  manifestPending?: boolean;
  manifestError?: boolean;
  framePending?: boolean;
  frameError?: boolean;
}): SimulatorStageState {
  if (manifestPending) {
    return { tone: 'loading', message: '正在读取 manifest', content: null };
  }
  if (manifestError) {
    return { tone: 'error', message: 'Manifest 加载失败', content: null };
  }
  if (!manifest || manifest.contents.length === 0) {
    return { tone: 'empty', message: 'Manifest 为空', content: null };
  }
  const content =
    manifest.contents.find((entry) => entry.id === selectedContentId) ??
    manifest.contents.find((entry) => entry.variant_status === 'ready') ??
    manifest.contents[0]!;
  if (content.variant_status !== 'ready') {
    return {
      tone: 'non-ready',
      message: `当前 Profile ${content.variant_status}`,
      content,
    };
  }
  if (framePending) {
    return { tone: 'frame-loading', message: '正在读取 raw frame', content };
  }
  if (frameError) {
    return { tone: 'frame-error', message: 'Raw frame 加载失败', content };
  }
  return { tone: 'ready', message: 'Frame ready', content };
}

export function manifestConditionalHeaders(cached: ManifestResponseT | undefined) {
  return cached ? { 'If-None-Match': cached.group.manifest_etag } : undefined;
}

export function resolveManifestResponse({
  status,
  data,
  cached,
}: {
  status: number;
  data: ManifestResponseT | undefined;
  cached: ManifestResponseT | undefined;
}): ManifestResponseT {
  if (status === 304 && cached) return cached;
  if (status === 200 && data) return data;
  throw new Error('Manifest 响应无可用内容');
}

export async function runSimulatorDownload(
  setDownload: (state: DownloadState) => void,
  download: () => Promise<void>
): Promise<void> {
  const identity = 'default';
  setDownload({ status: 'pending', identity });
  try {
    await download();
    setDownload({ status: 'success', identity });
  } catch (err) {
    setDownload({
      status: 'error',
      identity,
      message: err instanceof Error ? err.message : 'PNG 导出失败',
    });
  }
}

export function downloadOperationIdentity(input: DownloadOperationIdentityInput): string {
  return [input.groupId, input.profileId, input.contentId, input.imageEtag].join('\n');
}

export function beginDownloadOperation(
  input: DownloadOperationIdentityInput
): PendingDownloadState {
  return { status: 'pending', identity: downloadOperationIdentity(input) };
}

export function completeDownloadOperation(
  current: DownloadState,
  identity: string,
  result: { ok: true } | { ok: false; message: string }
): DownloadState {
  if (current.status !== 'pending' || current.identity !== identity) return current;
  return result.ok
    ? { status: 'success', identity }
    : { status: 'error', identity, message: result.message };
}

export async function runSimulatorDownloadForIdentity(
  setDownload: (update: DownloadState | ((current: DownloadState) => DownloadState)) => void,
  identityInput: DownloadOperationIdentityInput,
  download: () => Promise<void>
): Promise<void> {
  const pending = beginDownloadOperation(identityInput);
  setDownload(pending);
  try {
    await download();
    setDownload((current) => completeDownloadOperation(current, pending.identity, { ok: true }));
  } catch (err) {
    setDownload((current) =>
      completeDownloadOperation(current, pending.identity, {
        ok: false,
        message: err instanceof Error ? err.message : 'PNG 导出失败',
      })
    );
  }
}

export function selectedFrameFilename(
  manifest: ManifestResponseT,
  content: ContentSummaryT
): string {
  const seq = String(content.seq + 1).padStart(2, '0');
  return sanitizeFilename(
    `slate-${manifest.group.id}-${seq}-${content.id}-${content.frame.profile_id}-${content.image_etag}.png`
  );
}

export function batchSnapshotEntries(
  manifest: ManifestResponseT,
  rawByContentId: ReadonlyMap<string, Uint8Array>
): BatchSnapshotEntry[] {
  return manifest.contents
    .filter((content) => content.variant_status === 'ready')
    .map((content) => {
      const bytes = rawByContentId.get(content.id);
      if (!bytes) return null;
      return {
        contentId: content.id,
        filename: selectedFrameFilename(manifest, content),
        bytes,
        descriptor: content.frame,
      };
    })
    .filter((entry): entry is BatchSnapshotEntry => entry !== null);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-');
}
