// 顶层 API constants 和 Web 鉴权 schema。
// 设备协议 schema 在 types/device.ts 和 types/content.ts。

import { z } from 'zod';
import {
  DEFAULT_DISPLAY_PROFILE_ID,
  frameByteLength,
  getDisplayProfile,
} from './display-profiles.js';

// 单一前缀:Web、设备、外部 webhook 都挂在 /api/v2 下,鉴权按端点区分。
export const API_VERSION = 'v2';
export const API_PREFIX = '/api/v2';

// EPD 物理像素（zectrix Note4 4.2"）
const defaultDisplayProfile = getDisplayProfile(DEFAULT_DISPLAY_PROFILE_ID);
export const FRAME_WIDTH = defaultDisplayProfile.width;
export const FRAME_HEIGHT = defaultDisplayProfile.height;
export const FRAME_BYTES = frameByteLength(defaultDisplayProfile);
export const BW_THRESHOLD_DEFAULT = 128; // 后端 sharp pipeline 默认阈值（与固件 bw_threshold_=200 是两套独立通路，不联动）

// 音频:16kHz mono 16-bit raw PCM
export const AUDIO_SAMPLE_RATE = 16000;
export const AUDIO_BITS_PER_SAMPLE = 16;
export const AUDIO_CHANNELS = 1;

// 设备鉴权：注册流（POST /devices）无鉴权，body 里带 mac；
// 后续受保护端点全部用标准 Authorization: Bearer <device_secret>。
// secret 由注册响应一次性下发，固件 NVS 持久化；DB 只存 sha256(secret)。

export const LoginRequest = z.object({
  // 支持邮箱或用户名登录
  identifier: z.string().min(3),
  password: z.string().min(8),
});
export type LoginRequestT = z.infer<typeof LoginRequest>;

export const LoginResponse = z.object({
  token: z.string(),
  user: z.object({
    id: z.string(),
    email: z.email(),
    username: z.string(),
  }),
});
export type LoginResponseT = z.infer<typeof LoginResponse>;

// 注册请求：在登录基础上增加 email 和 username
export const RegisterRequest = z.object({
  email: z.email(),
  username: z.string().regex(/^[a-zA-Z0-9_]{3,32}$/, '用户名只能包含字母、数字、下划线，3-32 位'),
  password: z.string().min(8),
});
export type RegisterRequestT = z.infer<typeof RegisterRequest>;

export const RegisterResponse = LoginResponse;
export type RegisterResponseT = z.infer<typeof RegisterResponse>;

// envelope 包：所有错误响应统一字段。
export const ApiErrorEnvelope = z.object({
  error: z.string(),
  message: z.string(),
  detail: z.unknown().optional(),
  requestId: z.string().optional(),
});
export type ApiErrorEnvelopeT = z.infer<typeof ApiErrorEnvelope>;

// 通用 reorder body:把整集的 id 列表按新顺序提交。
// groups/contents 用 string[]，各自定义在 types/group.ts 和 types/content.ts。
export const ReorderRequest = <T extends z.ZodType<string | number>>(elem: T) =>
  z.object({ order: z.array(elem).min(1) });
