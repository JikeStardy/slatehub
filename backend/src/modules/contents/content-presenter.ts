import { createHash } from 'node:crypto';
import type { ContentAudioSource, ContentAudioStatus, ContentKind, Prisma } from '@prisma/client';
import {
  DEFAULT_DISPLAY_PROFILE_ID,
  DynamicConfig,
  frameDescriptorForProfile,
  getDisplayProfile,
  type DisplayProfileT,
  type FrameDescriptorT,
  TtsVoice,
  type ContentDetailT,
  type ContentSummaryT,
  type DynamicTypeT,
} from 'shared';
import { deviceStatusBarText } from '../dynamic-content/status-text/dynamic-content-status-text';

export interface ContentRow {
  id: string;
  groupId?: string;
  sortOrder: number;
  frameName: string | null;
  contentEtag: string;
  imageEtag: string;
  audioEtag: string | null;
  imageSize: number;
  audioSize: number | null;
  audioStatus: ContentAudioStatus;
  audioSource: ContentAudioSource | null;
  audioVoice: string | null;
  audioText?: string | null;
  audioLastError?: string | null;
  audioUpdatedAt?: Date | null;
  kind: ContentKind;
  dynamicType: string | null;
  dynamicNextRunAt?: Date | null;
  dynamicRefreshDueAt?: Date | null;
  dynamicConfig?: Prisma.JsonValue | null;
  dynamicData?: Prisma.JsonValue | null;
  dynamicLastRunAt?: Date | null;
  dynamicLastError?: string | null;
  variants?: ContentVariantRow[];
}

export interface ContentVariantRow {
  profileId: string;
  status: 'pending' | 'ready' | 'failed';
  pixelFormat: string;
  frameCodec: string;
  width: number;
  height: number;
  frameEtag: string | null;
  frameSize: number | null;
  storageKey: string | null;
  lastError?: string | null;
}

export interface ContentReadProfileTarget {
  profile: DisplayProfileT;
  audio: boolean;
  device?: boolean;
}

const DEFAULT_NOTE4_TARGET: ContentReadProfileTarget = {
  profile: getDisplayProfile(DEFAULT_DISPLAY_PROFILE_ID),
  audio: true,
};

export function contentToSummary(
  row: ContentRow,
  target: ContentReadProfileTarget = DEFAULT_NOTE4_TARGET
): ContentSummaryT {
  const voice = TtsVoice.safeParse(row.audioVoice);
  const selected = selectVariantSummary(row, target.profile.id);
  const audio = target.audio;
  return {
    id: row.id,
    seq: row.sortOrder,
    content_etag: selected.contentEtag,
    frame_name: row.frameName,
    device_status_bar_text: deviceStatusBarText({ ...row, renderedAt: row.dynamicLastRunAt }),
    image_etag: selected.imageEtag,
    audio_etag: audio ? row.audioEtag : null,
    image_size: selected.imageSize,
    variant_status: selected.status,
    audio_size: audio ? row.audioSize : null,
    audio_status: audio ? row.audioStatus : 'none',
    audio_source: audio ? row.audioSource : null,
    audio_voice: audio && voice.success ? voice.data : null,
    kind: contentKind(row.kind),
    dynamic_type: (row.dynamicType as DynamicTypeT | null) ?? null,
    next_wake_sec: nextWakeSec(row.dynamicNextRunAt ?? null),
    dynamic_next_run_at: row.dynamicNextRunAt?.toISOString() ?? null,
    dynamic_refresh_due_at: row.dynamicRefreshDueAt?.toISOString() ?? null,
    frame: selected.frame,
  };
}

export function devicePlayableProjection(
  rows: ContentRow[],
  target: ContentReadProfileTarget
): Array<{ content: ContentRow; summary: ContentSummaryT }> {
  return rows
    .map((content) => ({ content, summary: contentToSummary(content, target) }))
    .filter((entry) => entry.summary.variant_status === 'ready')
    .map((entry, seq) => ({
      content: entry.content,
      summary: { ...entry.summary, seq },
    }));
}

export function contentFrameResourceEtag(profileId: string, frameEtag: string): string {
  return compactReadEtag(['frame', profileId, frameEtag]);
}

export function contentSummaryEtag(profileId: string, frameEtag: string): string {
  return compactReadEtag(['content', profileId, frameEtag]);
}

export function manifestReadEtag(input: {
  profileId: string;
  group?: {
    id: string;
    name: string;
    sort_order: number;
    position: { current: number; total: number };
  };
  groupStructureEtag: string;
  contents: ContentSummaryT[];
}): string {
  return compactReadEtag([
    JSON.stringify({
      type: 'manifest',
      profileId: input.profileId,
      group: input.group
        ? {
            id: input.group.id,
            name: input.group.name,
            sortOrder: input.group.sort_order,
            position: {
              current: input.group.position.current,
              total: input.group.position.total,
            },
          }
        : null,
      groupStructureEtag: input.groupStructureEtag,
      contents: input.contents.map((content) => ({
        id: content.id,
        seq: content.seq,
        frameName: content.frame_name,
        deviceStatusBarText: content.device_status_bar_text,
        contentEtag: content.content_etag,
        variantStatus: content.variant_status,
        imageEtag: content.image_etag,
        imageSize: content.image_size,
        frame: {
          profileId: content.frame.profile_id,
          width: content.frame.width,
          height: content.frame.height,
          pixelFormat: content.frame.pixel_format,
          frameCodec: content.frame.frame_codec,
          byteLength: content.frame.byte_length,
        },
        audioEtag: content.audio_etag,
        audioSize: content.audio_size,
        audioStatus: content.audio_status,
        audioSource: content.audio_source,
        audioVoice: content.audio_voice,
        kind: content.kind,
        dynamicType: content.dynamic_type,
        dynamicNextRunAt: content.dynamic_next_run_at,
        dynamicRefreshDueAt: content.dynamic_refresh_due_at,
      })),
    }),
  ]);
}

export function validateReadyVariantForProfile(
  variant: ContentVariantRow,
  descriptor: FrameDescriptorT
): void {
  if (
    variant.profileId !== descriptor.profile_id ||
    variant.pixelFormat !== descriptor.pixel_format ||
    variant.frameCodec !== descriptor.frame_codec ||
    variant.width !== descriptor.width ||
    variant.height !== descriptor.height ||
    variant.frameSize !== descriptor.byte_length ||
    !variant.frameEtag ||
    !variant.storageKey
  ) {
    throw new Error('content variant metadata does not match its display profile');
  }
}

function selectVariantSummary(
  row: ContentRow,
  profileId: string
): {
  status: ContentSummaryT['variant_status'];
  contentEtag: string;
  imageEtag: string;
  imageSize: number;
  frame: FrameDescriptorT;
} {
  const frame = frameDescriptorForProfile(profileId);
  const variant = row.variants?.find((v) => v.profileId === profileId);
  if (!variant) return unavailableVariantSummary(profileId, frame, 'unavailable');
  if (variant.status !== 'ready')
    return unavailableVariantSummary(profileId, frame, variant.status);

  validateReadyVariantForProfile(variant, frame);
  return {
    status: 'ready',
    contentEtag: contentSummaryEtag(profileId, variant.frameEtag!),
    imageEtag: contentFrameResourceEtag(profileId, variant.frameEtag!),
    imageSize: variant.frameSize!,
    frame,
  };
}

function unavailableVariantSummary(
  profileId: string,
  frame: FrameDescriptorT,
  status: ContentSummaryT['variant_status']
): {
  status: ContentSummaryT['variant_status'];
  contentEtag: string;
  imageEtag: string;
  imageSize: number;
  frame: FrameDescriptorT;
} {
  return {
    status,
    contentEtag: compactReadEtag(['content', profileId, status]),
    imageEtag: '',
    imageSize: 0,
    frame,
  };
}

function compactReadEtag(parts: Array<string | number>): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32);
}

function contentKind(kind: ContentKind): ContentSummaryT['kind'] {
  switch (kind) {
    case 'image':
      return 'image';
    case 'dynamic':
      return 'dynamic';
    default:
      return assertNever(kind);
  }
}

function assertNever(value: never): never {
  throw new Error(`unsupported content kind: ${String(value)}`);
}

export function contentToDetail(
  row: ContentRow & {
    groupId: string;
    dynamicLastRunAt?: Date | null;
    dynamicLastError?: string | null;
  },
  target?: ContentReadProfileTarget
): ContentDetailT {
  const config = row.dynamicConfig ? DynamicConfig.safeParse(row.dynamicConfig) : null;
  return {
    ...contentToSummary(row, target),
    group_id: row.groupId,
    dynamic_config: config?.success ? config.data : null,
    dynamic_data: row.dynamicData ?? null,
    dynamic_last_rendered_at: row.dynamicLastRunAt?.toISOString() ?? null,
    dynamic_next_render_at: row.dynamicNextRunAt?.toISOString() ?? null,
    dynamic_render_error: row.dynamicLastError ?? null,
    audio_text: row.audioText ?? null,
    audio_error: row.audioLastError ?? null,
    audio_updated_at: row.audioUpdatedAt?.toISOString() ?? null,
  };
}

// 动态帧的唤醒下限：固件侧也有 60s 地板。这里把「已到期/时钟漂移」导致的 <=0 抬到
// 60s，避免下发 0 让固件按最小间隔反复空醒（静态帧 nextRunAt 为 null，仍返回 null 不配定时）。
export const MIN_DYNAMIC_WAKE_SEC = 60;

export function nextWakeSec(nextRunAt: Date | null, nowMs: number = Date.now()): number | null {
  if (!nextRunAt) return null;
  return Math.max(Math.ceil((nextRunAt.getTime() - nowMs) / 1000), MIN_DYNAMIC_WAKE_SEC);
}
