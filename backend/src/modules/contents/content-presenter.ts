import type { ContentAudioSource, ContentAudioStatus, ContentKind, Prisma } from '@prisma/client';
import {
  DEFAULT_DISPLAY_PROFILE_ID,
  DynamicConfig,
  frameDescriptorForProfile,
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
}

export function contentToSummary(row: ContentRow): ContentSummaryT {
  const voice = TtsVoice.safeParse(row.audioVoice);
  return {
    id: row.id,
    seq: row.sortOrder,
    content_etag: row.contentEtag,
    frame_name: row.frameName,
    device_status_bar_text: deviceStatusBarText({ ...row, renderedAt: row.dynamicLastRunAt }),
    image_etag: row.imageEtag,
    audio_etag: row.audioEtag,
    image_size: row.imageSize,
    audio_size: row.audioSize,
    audio_status: row.audioStatus,
    audio_source: row.audioSource,
    audio_voice: voice.success ? voice.data : null,
    kind: contentKind(row.kind),
    dynamic_type: (row.dynamicType as DynamicTypeT | null) ?? null,
    next_wake_sec: nextWakeSec(row.dynamicNextRunAt ?? null),
    frame: frameDescriptorForProfile(DEFAULT_DISPLAY_PROFILE_ID),
  };
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
  }
): ContentDetailT {
  const config = row.dynamicConfig ? DynamicConfig.safeParse(row.dynamicConfig) : null;
  return {
    ...contentToSummary(row),
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
