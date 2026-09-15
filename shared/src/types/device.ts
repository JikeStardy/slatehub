import { z } from 'zod';
import { BoardId, DisplayProfileId } from '../display-profiles.js';
import { ContentSummary } from './content.js';

export const MacAddress = z
  .string()
  .regex(/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/, 'invalid MAC address')
  .transform((s) => s.toUpperCase().replace(/-/g, ':'));

// 6 位配对码；后端生成字母表为 A-Z 去 I/L/O + 2-9，降低屏幕抄码混淆。
// Web 输入校验接受更宽的 A-Z0-9 与小写，再统一转大写，便于兼容历史码和用户输入。
export const PairCode = z
  .string()
  .regex(/^[A-Za-z0-9]{6}$/, 'invalid pair code')
  .transform((s) => s.toUpperCase());

// poll 响应里的 group 子对象。null = 还没选组。
// name 让设备 UI 文案具体化（"切换到「日常风景」" 而非 "切到第 3 个相册"）。
export const DeviceStateGroup = z.object({
  id: z.string(),
  structure_etag: z.string(),
  manifest_etag: z.string(),
  name: z.string(),
  content_count: z.number().int().nonnegative(),
  sort_order: z.number().int(),
  position: z.object({
    current: z.number().int().positive(),
    total: z.number().int().positive(),
  }),
});
export type DeviceStateGroupT = z.infer<typeof DeviceStateGroup>;

// poll 响应（无 reboot/action 队列）。
// bound = owner_user_id != null。pair_code 仅在 unbound 时返回（已绑定不需要）。
export const DeviceState = z.object({
  device: z.object({
    id: z.string(),
    mac: z.string(),
    name: z.string().nullable(),
    bound: z.boolean(),
    pair_code: z.string().nullable(),
    server_time: z.string().datetime(),
  }),
  group: DeviceStateGroup.nullable(),
  current_content: ContentSummary.nullable().optional(),
});
export type DeviceStateT = z.infer<typeof DeviceState>;

// 单一 poll 端点的请求体：可选 telemetry。
export const PollRequest = z.object({
  telemetry: z
    .object({
      battery_pct: z.number().int().min(0).max(100).optional(),
      rssi_dbm: z.number().int().optional(),
      fw_version: z.string().max(32).optional(),
      wake_reason: z.enum(['timer', 'button', 'power_on', 'charge', 'other']).optional(),
      current_group: z.string().nullable().optional(),
      current_content_seq: z.number().int().nonnegative().optional(),
      current_content_etag: z.string().max(64).optional(),
      manifest_etag: z.string().max(64).optional(),
    })
    .optional(),
});
export type PollRequestT = z.infer<typeof PollRequest>;

// 设备选指定组：PUT /api/v2/devices/current/group  body: {id}
export const SelectGroupByDeviceRequest = z.object({
  id: z.string(),
});
export type SelectGroupByDeviceRequestT = z.infer<typeof SelectGroupByDeviceRequest>;

// POST /api/v2/devices/current/group/next | /prev — direction 入 path，无 body。
export const CycleDirection = z.enum(['next', 'prev']);
export type CycleDirectionT = z.infer<typeof CycleDirection>;

// 注册端点：仅在固件 NVS 没有 device_secret 时调用（首次或物理重置后）。
// 同 mac 二次调用一律走 reset 路径（清 owner、轮换 secret + pair_code）。
// name 由 Web 端 claim 完成后通过 PUT /devices/:id 设置，注册阶段不带。
export const RegisterDeviceRequest = z.object({
  mac: MacAddress,
  board_id: BoardId,
  protocol_version: z.literal(2),
  fw_version: z.string().min(1).max(32),
});
export type RegisterDeviceRequestT = z.infer<typeof RegisterDeviceRequest>;

export const RegisterDeviceResponse = z.object({
  id: z.string(),
  mac: z.string(),
  // 64 字符 hex（sha256 摘要长度），固件 NVS 持久化后用作 Authorization: Bearer。
  device_secret: z.string().regex(/^[0-9a-f]{64}$/),
  pair_code: z.string().length(6),
  // true 表示后端发现 mac 已注册，按"物理重置即转移"语义清掉了上一任主人。
  reclaimed: z.boolean(),
  server_time: z.string().datetime(),
});
export type RegisterDeviceResponseT = z.infer<typeof RegisterDeviceResponse>;

export const PatchDeviceRequest = z.object({
  name: z.string().min(1).max(64).optional(),
  selected_group_id: z.string().nullable().optional(),
});
export type PatchDeviceRequestT = z.infer<typeof PatchDeviceRequest>;

// 用户在 Web 端输入设备屏上的 6 位配对码完成绑定。
export const ClaimDeviceRequest = z.object({
  pair_code: PairCode,
});
export type ClaimDeviceRequestT = z.infer<typeof ClaimDeviceRequest>;

export const ReorderDevicesRequest = z.object({
  order: z.array(z.string()).min(1),
});
export type ReorderDevicesRequestT = z.infer<typeof ReorderDevicesRequest>;

export const DeviceSummary = z.object({
  id: z.string(),
  mac: z.string(),
  name: z.string().nullable(),
  selected_group_id: z.string().nullable(),
  last_seen_at: z.string().datetime().nullable(),
  battery_pct: z.number().int().nullable(),
  rssi_dbm: z.number().int().nullable(),
  fw_version: z.string().nullable(),
  board_id: BoardId,
  display_profile_id: DisplayProfileId,
  protocol_version: z.number().int().positive(),
  owner_user_id: z.string().nullable(),
  sort_order: z.number().int(),
});
export type DeviceSummaryT = z.infer<typeof DeviceSummary>;
