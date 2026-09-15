# Slate / Shared

`shared` 是前端和后端共同消费的 TypeScript 源码包，包含：

- API 常量与 zod schema
- 设备、内容组、内容、动态内容类型
- 动态内容配置 catalog
- dashboard 模板 schema
- 热榜源 catalog
- 字体测试 catalog
- 真实板型 BoardDefinition 与显示格式 DisplayProfile registry
- 1bpp dither 与图像预处理纯函数

前端和后端都直接 import `shared/src`，运行期不需要先构建 `dist`。

## 入口与导出

[src/index.ts](src/index.ts) re-export：

```ts
export * from './api.js';
export * from './types/device.js';
export * from './types/group.js';
export * from './types/content.js';
export * from './types/dynamic.js';
export * from './dither.js';
export * from './preprocess.js';
```

`package.json` 同时暴露：

```json
{
  ".": "./src/index.ts",
  "./types/*": "./src/types/*.ts",
  "./api": "./src/api.ts",
  "./dynamic/*": "./src/dynamic/*.ts"
}
```

## 目录

```text
shared/src/
├── api.ts                       API_PREFIX、帧/音频常量、登录注册 schema、错误 envelope
├── display-profiles.ts          BoardDefinition、DisplayProfile、descriptor helper
├── display-profiles.json        真实板型与开发/测试 profile registry
├── dither.ts                    1bpp dither 算法
├── preprocess.ts                RGBA/RGB 灰度化、autoInvert、autoContrast
├── types/
│   ├── device.ts                设备注册、poll、DeviceState、claim、reorder
│   ├── group.ts                 内容组 CRUD、summary、reorder
│   ├── content.ts               内容 detail、manifest、preview、TTS、ingest schema
│   └── dynamic.ts               dynamic/ 的兼容 re-export
└── dynamic/
    ├── config.ts                DynamicConfig discriminated union、TTS voice、ingest schema
    ├── fonts.ts                 字体测试 catalog
    ├── hot-list-sources.ts      热榜源 catalog 与 legacy alias
    ├── templates.ts             dashboard template schema 与内置模板
    ├── test-fixtures.ts         前端预览/新建 dashboard 默认数据
    └── index.ts                 dynamic barrel
```

## 常量

[src/api.ts](src/api.ts)：

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `API_VERSION` | `v2` | API 版本 |
| `API_PREFIX` | `/api/v2` | 除 `/healthz` 外的 HTTP 前缀 |
| `FRAME_WIDTH` | `400` | 默认生产 DisplayProfile 宽度 |
| `FRAME_HEIGHT` | `300` | 默认生产 DisplayProfile 高度 |
| `FRAME_BYTES` | `15000` | 默认生产 DisplayProfile packed 1bpp 字节数 |
| `BW_THRESHOLD_DEFAULT` | `128` | 默认二值阈值 |
| `AUDIO_SAMPLE_RATE` | `16000` | 设备 PCM 采样率 |
| `AUDIO_BITS_PER_SAMPLE` | `16` | PCM 位深 |
| `AUDIO_CHANNELS` | `1` | 单声道 |

1bpp 字节序约定：MSB-first，bit=1 白，bit=0 黑，与固件 EPD 驱动一致。

## BoardDefinition 与 DisplayProfile

`display-profiles.json` 把真实硬件和显示格式分开维护：

- `BoardDefinition` 是固件 / release 的真实板型行，当前只有 `zectrix-note4`。它引用一个 `display_profile_id`，并声明音频、局刷等硬件能力。
- `DisplayProfile` 是渲染和协议 descriptor，包含 `width`、`height`、`pixel_format`、`frame_codec` 与 `availability`。
- `virtual-mono-296x128` 只有 `development` / `test` 可用，用于后端测试、前端 HTML Canvas/PNG 模拟器和小尺寸渲染验证，不允许进入 firmware matrix 或 GitHub Release artifact。当前真实硬件验证仅覆盖 Note4；virtual 输出只证明渲染字节与像素，不证明物理面板刷新、波形、电源或功耗行为。

新增真实 ESP 屏幕设备时，先新增 production-capable DisplayProfile，再新增 BoardDefinition 指向它；后端据此生成 per-profile content variant，前端据此预览，固件据此校验 manifest/frame descriptor。

## Schema 命名约定

每个 schema 使用 `PascalCase`，对应类型使用 `PascalCaseT`：

```ts
export const PollRequest = z.object({
  telemetry: z.object({ ... }).optional(),
});
export type PollRequestT = z.infer<typeof PollRequest>;
```

后端 DTO 通过 `static schema = PollRequest` 接入全局 `ZodValidationPipe`。前端使用 `*T` 类型标注 API 请求和响应。

## 设备协议类型

[src/types/device.ts](src/types/device.ts) 定义：

- `RegisterDeviceRequest` / `RegisterDeviceResponse`
- `PollRequest`
- `DeviceState`
- `SelectGroupByDeviceRequest`
- `ClaimDeviceRequest`
- `PatchDeviceRequest`
- `ReorderDevicesRequest`
- `DeviceSummary`

核心约定：

- `MacAddress` 接受 `AA:BB:...` 或 `AA-BB-...`，输出大写冒号格式。
- `device_secret` 是 64 字符 hex，只在注册响应返回一次。
- `PairCode` 接受 6 位字母数字并转大写；后端生成时使用去掉易混淆字符的字母表。
- `PollRequest.telemetry.wake_reason` 为 `timer | button | power_on | charge | other`。
- `DeviceState.current_content` 可选，用于固件 timer wake 时只刷新当前动态帧。

## 内容类型

[src/types/content.ts](src/types/content.ts) 定义：

- `ContentKind = image | dynamic`
- `ContentAudioStatus = none | pending | generating | ready | failed`
- `ContentAudioSource = upload | tts`
- `ContentSummary`
- `ContentDetail`
- `ManifestResponse`
- `CreateDynamicContentRequest`
- `PatchDynamicContentRequest`
- `PreviewDynamicContentRequest`
- `GenerateContentTtsRequest`

`ContentSummary` 是设备 manifest 和 `current_content` 共用的轻量结构。`ContentDetail` 是 Web 管理端编辑页使用的完整结构，额外包含 `dynamic_config`、`dynamic_data`、动态渲染状态和音频错误信息。

## 动态内容配置

[src/dynamic/config.ts](src/dynamic/config.ts) 中的 `DynamicType` 当前包含：

```ts
[
  'daily_calendar',
  'month_calendar',
  'weather',
  'history_today',
  'weather_alert',
  'earthquake_report',
  'dashboard',
  'font_test',
  'hot_list',
]
```

`DynamicConfig` 是 discriminated union，各类型的 `type` 字段作为 discriminator。

公共选项：

- 多数自然语言动态内容支持 `audio_enabled` 和 `audio_voice`。
- 周期型内容支持 `refresh_interval_sec`，不同类型范围不同。
- `TTS_VOICES` 当前为 `冰糖`、`茉莉`、`苏打`、`白桦`、`Mia`、`Chloe`、`Milo`、`Dean`。
- `DEFAULT_TTS_VOICE = '冰糖'`。

`isAudioDynamicConfig()` 用于判断某个动态内容配置是否支持动态音频。

## Dashboard 模板

[src/dynamic/templates.ts](src/dynamic/templates.ts) 定义 dashboard 的自定义模板 schema。

模板坐标系：

- 画布使用目标 DisplayProfile 的像素坐标；Note4 为 400 x 300。
- `DeviceRect.y` 最小为 24，保留固件状态栏区域。
- rect 必须在屏幕范围内。
- 最多 32 个 block。

支持 block：

- `text`
- `metric`
- `progress`
- `sparkline`
- `line`
- `rect`

内置系统模板：

- `ai_usage_stats`
- `ai_quota_monitor`

dashboard 配置结构：

```ts
{
  type: 'dashboard';
  template:
    | { kind: 'system'; id: 'ai_usage_stats' | 'ai_quota_monitor' }
    | { kind: 'custom'; template: DashboardTemplateT };
  refresh_interval_sec: number;
}
```

dashboard 数据推送 schema：

```ts
{
  version: 1,
  data: Record<string, unknown>
}
```

`data` 必须至少包含一个字段。推送端点在后端是 capability URL，`contentId` 即凭证。

## 热榜源

[src/dynamic/hot-list-sources.ts](src/dynamic/hot-list-sources.ts) 维护前端可选源 catalog 与 legacy id alias。

源类型：

- `general`
- `news`
- `tech`
- `community`
- `commerce`

`normalizeHotListSourceId()` 会把旧 ID 映射到当前 ID，例如：

- `baidutieba` -> `tieba`
- `hostloc` -> `nodeseek`
- `bilibili-hot-video` -> `bilibili`

后端实际 fetcher registry 在 `backend/src/modules/hot-list/`，shared 只维护配置和 UI catalog。

## 字体测试

[src/dynamic/fonts.ts](src/dynamic/fonts.ts) 定义 `FontTestFontId` 和展示 catalog。当前覆盖：

- CJK 像素字体：Fusion Pixel、Zfull-GB、Ark Pixel、Z Labs、ChillBitmap、Cubic、Unifont
- Latin 等宽点阵：Spleen、Cozette、Montserrat
- icon 字体：Font Awesome 14 / 30

后端运行时对应资产位于 `backend/assets/fonts/bitmap-1bpp/*.json`。

## Dither 算法

[src/dither.ts](src/dither.ts) 提供 6 种模式：

| `DitherMode` | UI 标签 | 说明 |
| --- | --- | --- |
| `threshold` | 线稿 · 纯黑白 | 硬阈值 |
| `bayer4` | 网点 · 粗 | Bayer 4x4 |
| `bayer8` | 网点 · 细 | Bayer 8x8 |
| `floyd` | 照片 · 推荐 | Floyd-Steinberg |
| `atkinson` | 照片 · 高对比 | Atkinson |
| `sierra` | 照片 · 柔和 | Sierra Lite |

默认值：

- `API_DEFAULT_DITHER_MODE = 'threshold'`：后端 API 未指定 mode 时使用，保证旧调用方行为稳定。
- `DEFAULT_DITHER_MODE = 'floyd'`：前端新建图片内容的默认值。

主要函数：

```ts
ditherToBinary(gray, width, height, options): Uint8Array
ditherTo1bpp(gray, width, height, options): Uint8Array
```

`ditherToBinary` 输出每像素 0/255，适合前端 canvas 预览。`ditherTo1bpp` 输出 packed 1bpp，适合设备帧缓存。

`DitherOptions`：

```ts
{
  mode: DitherMode;
  threshold?: number;     // 默认 128
  serpentine?: boolean;   // 误差扩散默认 true
  gammaCorrect?: boolean; // 默认 true
}
```

## 图像预处理

[src/preprocess.ts](src/preprocess.ts) 规定前后端一致的预处理顺序：

1. 解码到 RGB/RGBA。
2. `rgbaToGray`：Rec.709 系数。
3. `autoInvert`：四角内一格均值小于 128 时视为黑底并整体反相。
4. `autoContrast(cutoffPct=1)`：等价 PIL `ImageOps.autocontrast` 的 cutoff 拉伸。
5. `ditherToBinary` 或 `ditherTo1bpp`。

前端图片编辑器和后端 `ImageRendererService` 都应按这个顺序执行，否则 Web 预览和设备显示会不一致。

## 用法

后端：

```ts
import {
  API_PREFIX,
  FRAME_BYTES,
  ManifestResponse,
  DynamicConfig,
  ditherTo1bpp,
} from 'shared';
```

前端：

```ts
import type { ContentDetailT, DeviceSummaryT, DynamicConfigT } from 'shared';
import { DEFAULT_DITHER_MODE, DynamicConfig, ditherToBinary } from 'shared';
```

## 校验

```bash
bun run --cwd shared typecheck
```

`shared/package.json` 的 `build` 只是 `tsc`，当前项目运行期不消费构建产物。
