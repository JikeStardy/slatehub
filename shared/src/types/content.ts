import { z } from 'zod';
import { DITHER_MODES } from '../dither.js';
import { DisplayProfile, DisplayProfileId, FrameDescriptor } from '../display-profiles.js';
import { DashboardDataPayload, DynamicConfig, DynamicType, TtsVoice } from './dynamic.js';

export const ContentKind = z.enum(['image', 'dynamic']);
export type ContentKindT = z.infer<typeof ContentKind>;

export const ContentAudioStatus = z.enum(['none', 'pending', 'generating', 'ready', 'failed']);
export type ContentAudioStatusT = z.infer<typeof ContentAudioStatus>;

export const ContentAudioSource = z.enum(['upload', 'tts']);
export type ContentAudioSourceT = z.infer<typeof ContentAudioSource>;

export const ContentVariantReadStatus = z.enum(['ready', 'pending', 'failed', 'unavailable']);
export type ContentVariantReadStatusT = z.infer<typeof ContentVariantReadStatus>;

export const PatchContentRequest = z.object({
  frame_name: z.string().max(64).nullable().optional(),
});
export type PatchContentRequestT = z.infer<typeof PatchContentRequest>;

export const ReorderContentsRequest = z.object({
  order: z.array(z.string().min(1)).min(1),
});
export type ReorderContentsRequestT = z.infer<typeof ReorderContentsRequest>;

export const ContentSummary = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative(),
  content_etag: z.string(),
  frame_name: z.string().nullable(),
  device_status_bar_text: z.string(),
  image_etag: z.string(),
  audio_etag: z.string().nullable(),
  image_size: z.number().int().nonnegative(),
  variant_status: ContentVariantReadStatus,
  audio_size: z.number().int().nonnegative().nullable(),
  audio_status: ContentAudioStatus,
  audio_source: ContentAudioSource.nullable(),
  audio_voice: TtsVoice.nullable(),
  kind: ContentKind,
  dynamic_type: DynamicType.nullable(),
  next_wake_sec: z.number().int().nonnegative().nullable(),
  frame: FrameDescriptor,
});
export type ContentSummaryT = z.infer<typeof ContentSummary>;

export const ContentDetail = ContentSummary.extend({
  group_id: z.string(),
  dynamic_config: DynamicConfig.nullable(),
  dynamic_data: z.unknown().nullable(),
  dynamic_last_rendered_at: z.string().datetime().nullable(),
  dynamic_next_render_at: z.string().datetime().nullable(),
  dynamic_render_error: z.string().nullable(),
  audio_text: z.string().nullable(),
  audio_error: z.string().nullable(),
  audio_updated_at: z.string().datetime().nullable(),
});
export type ContentDetailT = z.infer<typeof ContentDetail>;

export const ContentMutationResponse = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative(),
  content_etag: z.string(),
  image_etag: z.string(),
  audio_etag: z.string().nullable(),
  manifest_etag: z.string(),
});
export type ContentMutationResponseT = z.infer<typeof ContentMutationResponse>;

export const CreateDynamicContentRequest = z
  .object({
    kind: z.literal('dynamic'),
    config: DynamicConfig,
    frame_name: z.string().max(64).nullable().optional(),
    initial_data: DashboardDataPayload.optional(),
  })
  .superRefine((body, ctx) => {
    if (body.config.type !== 'dashboard' || body.initial_data !== undefined) return;
    ctx.addIssue({
      code: 'custom',
      path: ['initial_data'],
      message: 'dashboard 初始数据不能为空',
    });
  });
export type CreateDynamicContentRequestT = z.infer<typeof CreateDynamicContentRequest>;

export const PatchDynamicContentRequest = z.object({
  frame_name: z.string().max(64).nullable().optional(),
  config: DynamicConfig.optional(),
});
export type PatchDynamicContentRequestT = z.infer<typeof PatchDynamicContentRequest>;

export const PreviewDynamicContentRequest = z.object({
  config: DynamicConfig,
  display_profile_id: DisplayProfileId,
  frame_name: z.string().max(64).nullable().optional(),
  data: DashboardDataPayload.optional(),
});
export type PreviewDynamicContentRequestT = z.infer<typeof PreviewDynamicContentRequest>;

export const GenerateContentTtsRequest = z.object({
  text: z.string().trim().min(1).max(500),
  voice: TtsVoice,
});
export type GenerateContentTtsRequestT = z.infer<typeof GenerateContentTtsRequest>;

export const ManifestResponse = z.object({
  group: z.object({
    id: z.string(),
    structure_etag: z.string(),
    manifest_etag: z.string(),
    name: z.string(),
    sort_order: z.number().int(),
    position: z.object({
      current: z.number().int().positive(),
      total: z.number().int().positive(),
    }),
  }),
  display_profile: DisplayProfile,
  contents: z.array(ContentSummary),
});
export type ManifestResponseT = z.infer<typeof ManifestResponse>;

export const RenderContentRequest = z.object({
  source: z.enum(['markdown', 'html', 'png_base64']),
  content: z.string(),
  threshold: z.number().int().min(0).max(255).optional(),
  mode: z.enum(DITHER_MODES).optional(),
  display_profile_id: DisplayProfileId,
});
export type RenderContentRequestT = z.infer<typeof RenderContentRequest>;
