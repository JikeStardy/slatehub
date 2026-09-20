# SlateHub Hard Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将产品、部署、发布和 ESP32 固件从旧品牌完整断代为 `SlateHub` / `slatehub`，在虚拟机内完成构建验证，并将全量镜像重新刷写到当前 ZecTrix Note4。

**Architecture:** 把改名视为一项跨边界协议变更：发布 metadata、Docker/NAS 部署、Web 可见品牌、固件编译配置和设备持久化标识必须在同一分支上同步切换。每个子系统先用自己的契约测试锁定新名称，最后再由仓库级品牌守卫、全量质量门和实机验收证明没有留下会重新依赖上游的生产路径。

**Tech Stack:** Bun 1.x、TypeScript、NestJS 11、React 19、Docker Compose、GitHub Actions、ESP-IDF 5.5.2、CMake/CTest、ESP32-S3、Lima `slate-build`、esptool 5.4.0。

**Spec:** `docs/superpowers/specs/2026-09-21-slatehub-hard-rename-design.md`

## Global Constraints

- 用户可见品牌只能使用 `SlateHub`，机器标识只能使用 `slatehub`。
- GitHub 仓库固定为 `JikeStardy/slatehub`，GHCR 镜像固定为 `ghcr.io/jikestardy/slatehub`。
- 根 Compose 默认镜像为 `ghcr.io/jikestardy/slatehub:master`，通过 `SLATEHUB_IMAGE` 覆盖。
- Compose 服务/容器、MySQL database/user 和持久化目录使用 `slatehub` / `slatehub-mysql` / `./slatehub`。
- 固件、backend job 和测试配置前缀统一为 `SLATEHUB_` / `CONFIG_SLATEHUB_`，不读取旧前缀。
- OTA `product` 为 `slatehub`，产物为 `slatehub-{board_id}-vX.Y.Z-{full|ota}.bin` 及同名前缀 metadata/checksum。
- NVS namespace 固定为 `slatehub.net`、`slatehub.audio`、`slatehub.xiao`、`slatehub.x.mq`、`slatehub.x.ws`，不迁移旧 namespace。
- 版本统一提升到 `0.2.0`，包括四个 package、`bun.lock` workspace 记录和 `CONFIG_APP_PROJECT_VER`。
- 只在根 README 致谢段落和 `NOTICE.md` 中保留原项目名称与 URL；`docs/superpowers/` 是已批准的历史设计/执行记录，不参与运行面品牌守卫。
- 不增加 runtime dependency，不保留兼容 alias，不修改 `/api/v2`、协议版本 `2`、board id 或 DisplayProfile id。
- ESP-IDF、CMake/Ninja、Docker Engine/Compose 等重型工具只在 Lima `slate-build` 虚拟机内使用；主机只使用已有 Bun/Node、Lima 控制端和临时 `uvx` 串口工具。
- 不推送 GitHub、不创建 tag、不创建 Release；所有提交保持在本地，等待用户另行授权。

## Review Focus

1. **旧 OTA metadata 或伪装文件名**：`product` 为旧值、文件名与 URL basename 不一致时，Node 工具和固件都必须拒绝。
2. **旧环境变量静默生效**：只设置旧 job/firmware 前缀时必须表现为缺少新配置，而不是读取兼容值。
3. **NVS 名称超限或历史数据回流**：新 namespace 必须通过 15 字节编译期检查，代码中不得再定义或遍历历史 namespace。
4. **上游依赖重新进入生产面**：除 README/NOTICE 致谢外，运行代码、Compose、workflow、下载链接和 User-Agent 不得包含原仓库 URL 或旧 GHCR 镜像。
5. **设备刷写后仍保留旧状态**：必须先整片擦除，再从 `0x0` 写入 full image，并由启动日志证明 `slatehub`、版本 `0.2.0`、首次配网和显示全刷。

---

### Task 1: Version, Release Metadata, and CI Artifact Identity

**Files:**
- Modify: `package.json`
- Modify: `backend/package.json`
- Modify: `frontend/package.json`
- Modify: `shared/package.json`
- Modify: `bun.lock`
- Modify: `firmware/sdkconfig.defaults`
- Modify: `shared/schemas/firmware-release-metadata.schema.json`
- Modify: `tools/firmware-release-metadata.mjs`
- Modify: `tools/firmware-release-metadata.test.mjs`
- Modify: `tools/check-release-contract.mjs`
- Modify: `.github/workflows/docker.yml`
- Modify: `.github/workflows/firmware.yml`
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `BoardDefinition.id` values from `shared/src/display-profiles.json`; annotated release tag format `vX.Y.Z`.
- Produces: metadata `{ schema_version: 1, product: 'slatehub', board_id, version, release_tag, artifact }`; firmware artifacts prefixed `slatehub-`; image repository `ghcr.io/${owner}/slatehub`.

- [ ] **Step 1: Change metadata tests to require the new product and file prefix**

Update all positive fixtures in `tools/firmware-release-metadata.test.mjs` to use:

```js
const artifactName = `slatehub-${boardId}-${tag}-ota.bin`;
expect(metadata.product).toBe('slatehub');
```

Keep an explicit negative case for the retired product without leaving a searchable old literal:

```js
const retiredProduct = ['s', 'late'].join('');
metadata.product = retiredProduct;
const result = runVerify(metadata, artifact);
assert.notEqual(result.status, 0);
assert.match(result.stderr, /product must be slatehub/);
```

- [ ] **Step 2: Run the metadata suite and confirm it fails on the current implementation**

Run: `bun run test:release-metadata`

Expected: FAIL because the tool still emits `product: "slate"` and old-prefixed filenames.

- [ ] **Step 3: Rename the metadata schema and generator contract**

Set the generator constants and expected filename in `tools/firmware-release-metadata.mjs`:

```js
const product = 'slatehub';

function expectedOtaFilename(boardId, releaseTag) {
  return `slatehub-${boardId}-${releaseTag}-ota.bin`;
}
```

Update the JSON Schema identity and constraints:

```json
{
  "$id": "https://slatehub.local/schemas/firmware-release-metadata.schema.json",
  "title": "SlateHubFirmwareReleaseMetadata",
  "properties": {
    "product": { "const": "slatehub" }
  }
}
```

Use `^slatehub-[a-z0-9-]+-v...-ota\\.bin$` for the artifact filename pattern.

- [ ] **Step 4: Rename workflow image and firmware artifact surfaces**

Apply these exact workflow identities:

```yaml
env:
  IMAGE: ghcr.io/${{ github.repository_owner }}/slatehub
```

Firmware commands must use `CONFIG_SLATEHUB_BOARD_ID`, `/tmp/slatehub-sdkconfig.*`, `build/slatehub.bin`, and `slatehub-${{ matrix.board_id }}-{full|ota}.bin`. Release jobs, upload artifact names, download patterns, checksum names, and `slatehub.env.example` must use the same prefix.

- [ ] **Step 5: Update the release-contract assertions before running them**

Change `tools/check-release-contract.mjs` fixtures and regular expressions so they assert:

```js
const artifactName = `slatehub-${boardId}-${tag}-ota.bin`;
const downloadUrl =
  `https://github.com/example/slatehub/releases/download/${tag}/${artifactName}`;
```

Add assertions that both Docker workflows use a repository ending in `/slatehub`, and that the firmware/release workflows contain no retired artifact prefix or `CONFIG_` prefix. Construct any negative fixture from string parts so the final brand guard can distinguish a deliberate rejection test from a production literal.

- [ ] **Step 6: Synchronize the single product version**

Set root/backend/frontend/shared package versions and `CONFIG_APP_PROJECT_VER` to `0.2.0`, then run:

```bash
bun install
```

Expected: `bun.lock` records `0.2.0` for the root and all three workspaces, with no dependency upgrades unrelated to the version change.

- [ ] **Step 7: Run release contract tests**

Run:

```bash
bun run test:release-metadata
bun run check:release-contract
```

Expected: both commands exit 0; virtual profiles remain rejected as firmware artifacts; old product and filename fixtures fail verification.

- [ ] **Step 8: Commit the release identity change**

```bash
git add package.json backend/package.json frontend/package.json shared/package.json bun.lock \
  firmware/sdkconfig.defaults shared/schemas/firmware-release-metadata.schema.json \
  tools/firmware-release-metadata.mjs tools/firmware-release-metadata.test.mjs \
  tools/check-release-contract.mjs .github/workflows/docker.yml \
  .github/workflows/firmware.yml .github/workflows/release.yml
git commit -m $'feat(release): 切换 SlateHub 发布身份\n\n- 统一 0.2.0 产品版本与 GHCR 镜像名\n- 断代 OTA metadata 和固件附件命名\n- 更新滚动构建与正式发布契约'
```

### Task 2: NAS Deployment and Backend Runtime Identity

**Files:**
- Modify: `compose.yml`
- Modify: `.env.example`
- Modify: `backend/.env.example`
- Modify: `Dockerfile`
- Modify: `entrypoint.sh`
- Modify: `backend/prisma/schema.prisma`
- Rename: `backend/scripts/lib/slate-ingest.ts` -> `backend/scripts/lib/slatehub-ingest.ts`
- Rename: `backend/scripts/lib/slate-ingest.test.ts` -> `backend/scripts/lib/slatehub-ingest.test.ts`
- Modify: `backend/scripts/lib/job.ts`
- Modify: `backend/scripts/job-runner.ts`
- Modify: `backend/scripts/lib/time.ts`
- Modify: `backend/scripts/jobs/sub2api-usage-stats.ts`
- Modify: `backend/scripts/jobs/claude-code-quota-monitor.ts`
- Modify: `backend/scripts/fonts/generate-font-test-assets.sh`
- Modify: `backend/scripts/fonts/generate-zfull-font-assets.sh`
- Modify: `backend/scripts/debug/render-dynamic-debug.ts`
- Modify: `backend/src/common/rate-limit/rate-limit-guard.ts`
- Modify: `backend/src/infra/config/env.schema.test.ts`
- Modify: `backend/src/infra/logger/pino-options.ts`
- Modify: `backend/src/infra/blob/blob.service.test.ts`
- Modify: `backend/src/modules/audio/audio-transcoder.service.ts`
- Modify: `backend/src/modules/dynamic-content/providers/history-today.provider.ts`
- Modify: `backend/src/modules/dynamic-content/providers/history-today.provider.test.ts`
- Modify: `backend/src/modules/dynamic-content/rendering/fonts/font-test-utils.ts`
- Modify: `backend/src/modules/dynamic-content/dynamic-content-renderer.service.test.ts`
- Modify: `backend/src/modules/rendering/variant-render.service.test.ts`

**Interfaces:**
- Consumes: backend `/healthz`, `/api/v2`, MySQL 8, Docker image from Task 1.
- Produces: Compose service `slatehub`, MySQL service/container `slatehub-mysql`, `SLATEHUB_RUN_MODE`, `SLATEHUB_JOB*`, `SLATEHUB_API_BASE`, `SlateHubJob`, and `slatehubIngestURL()`.

- [ ] **Step 1: Rename the ingest helper test and make the API parameter explicit**

The renamed `backend/scripts/lib/slatehub-ingest.test.ts` must contain:

```ts
import { describe, expect, it } from 'bun:test';
import { slatehubIngestURL } from './slatehub-ingest';

describe('slatehubIngestURL', () => {
  it('builds dashboard ingest URLs from the shared v2 prefix', () => {
    expect(slatehubIngestURL('https://hub.example/', 'content-1')).toBe(
      'https://hub.example/api/v2/contents/content-1/data'
    );
  });
});
```

- [ ] **Step 2: Add a no-compatibility job environment regression test**

Export `validateJobID` and a pure `readRunnerConfig(env)` from `backend/scripts/job-runner.ts`, then create `backend/scripts/job-runner.test.ts` with:

```ts
import { describe, expect, it } from 'bun:test';
import { readRunnerConfig } from './job-runner';

describe('readRunnerConfig', () => {
  it('requires SLATEHUB_JOB and ignores the retired prefix', () => {
    const retiredKey = ['S', 'LATE_JOB'].join('');
    expect(() => readRunnerConfig({ [retiredKey]: 'sub2api-usage-stats' })).toThrow(
      'Missing required environment variable SLATEHUB_JOB'
    );
  });

  it('reads only SlateHub job controls', () => {
    expect(
      readRunnerConfig({
        SLATEHUB_JOB: 'sub2api-usage-stats',
        SLATEHUB_JOB_INTERVAL_SECONDS: '60',
        SLATEHUB_JOB_RUN_ONCE: '1',
      })
    ).toEqual({ jobID: 'sub2api-usage-stats', intervalSeconds: 60, runOnce: true });
  });
});
```

Guard `main()` with `if (import.meta.main)` so importing the module does not start a job.

- [ ] **Step 3: Run the focused backend tests and confirm they fail**

Run:

```bash
bun test backend/scripts/lib/slatehub-ingest.test.ts backend/scripts/job-runner.test.ts \
  backend/src/modules/dynamic-content/providers/history-today.provider.test.ts
```

Expected: FAIL because the renamed exports and new environment contract do not exist yet.

- [ ] **Step 4: Implement the backend code and identifier rename**

Use these public names consistently:

```ts
export interface SlateHubJob {
  id: string;
  description: string;
  run(): Promise<void>;
}

export function slatehubIngestURL(slatehubAPIBase: string, contentID: string): string {
  return `${stripTrailingSlash(slatehubAPIBase)}${API_PREFIX}/contents/${contentID}/data`;
}
```

Rename job config to `SLATEHUB_JOB`, `SLATEHUB_JOB_DIR`, `SLATEHUB_JOB_INTERVAL_SECONDS`, `SLATEHUB_JOB_RUN_ONCE`, `SLATEHUB_JOB_TIME_ZONE`, and `SLATEHUB_API_BASE`. Rename logger labels, local property names, cache/temp paths, rate-limit key, font fixture text, Prisma comment, and test temporary directories to `SlateHub`/`slatehub`; do not add fallback reads.

Set the history provider User-Agent to:

```ts
const USER_AGENT =
  'SlateHub/0.2 (+https://github.com/JikeStardy/slatehub; history-today-provider)';
```

Update its test to assert the current repository URL and to reject the old owner assembled from string parts.

- [ ] **Step 5: Replace the entrypoint and healthcheck environment variable**

`entrypoint.sh` and the Docker healthcheck must read only:

```sh
SLATEHUB_RUN_MODE
```

The default remains `server`; `job` launches `scripts/job-runner.ts`; any other value exits 1 and names `SLATEHUB_RUN_MODE` in the error.

- [ ] **Step 6: Rewrite Compose as a clean SlateHub installation**

The root service must start with:

```yaml
services:
  slatehub:
    image: ${SLATEHUB_IMAGE:-ghcr.io/jikestardy/slatehub:master}
    container_name: slatehub
    volumes:
      - ./slatehub:/data
    environment:
      DATABASE_URL: mysql://slatehub:${MYSQL_PASSWORD:?set MYSQL_PASSWORD in .env}@mysql:3306/slatehub
```

MySQL must use database/user `slatehub`, container `slatehub-mysql`, and healthcheck user `slatehub`. Preserve the internal service hostname `mysql`, because it is infrastructure identity rather than product identity.

- [ ] **Step 7: Run focused and complete backend tests**

Run:

```bash
bun test backend/scripts/lib/slatehub-ingest.test.ts backend/scripts/job-runner.test.ts \
  backend/src/modules/dynamic-content/providers/history-today.provider.test.ts \
  backend/src/infra/config/env.schema.test.ts
bun run --cwd backend test
bun run --cwd backend typecheck
bun run --cwd backend lint
```

Expected: all pass; importing the job runner does not execute `main()`; no old environment variable is read.

- [ ] **Step 8: Commit the deployment/runtime change**

```bash
git add compose.yml .env.example backend/.env.example Dockerfile entrypoint.sh backend/prisma \
  backend/scripts backend/src
git commit -m $'feat(backend): 断代 SlateHub 部署与运行身份\n\n- 切换 NAS Compose 数据库、服务和镜像配置\n- 统一 job 环境变量与内部标识\n- 移除运行时上游仓库引用'
```

### Task 3: Web Brand, Browser Storage, and PNG Export Identity

**Files:**
- Create: `frontend/src/app/brand.ts`
- Create: `frontend/src/app/brand.test.ts`
- Modify: `frontend/index.html`
- Modify: `frontend/src/components/layout/Layout.tsx`
- Modify: `frontend/src/features/auth/components/AuthLayout.tsx`
- Modify: `frontend/src/features/auth/lib/auth-storage.ts`
- Modify: `frontend/src/features/devices/components/AddDeviceDialog.tsx`
- Modify: `frontend/src/features/simulator/lib/simulator-frame.ts`
- Modify: `frontend/src/features/simulator/lib/simulator-frame.test.ts`

**Interfaces:**
- Consumes: existing Mono Press `IconBlock`, simulator frame descriptor and browser `localStorage`.
- Produces: `PRODUCT_NAME`, `PRODUCT_TAGLINE`, `PRODUCT_VERSION_LABEL`; storage key `slatehub_jwt`; exported PNG prefix `slatehub-`.

- [ ] **Step 1: Write the Web brand contract test**

Create `frontend/src/app/brand.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PRODUCT_NAME, PRODUCT_TAGLINE, PRODUCT_VERSION_LABEL } from './brand';
import { AUTH_TOKEN_STORAGE_KEY } from '@/features/auth/lib/auth-storage';

describe('SlateHub brand contract', () => {
  it('publishes the hard-renamed product identity', () => {
    expect(PRODUCT_NAME).toBe('SlateHub');
    expect(PRODUCT_TAGLINE).toBe('案头那块墨水屏');
    expect(PRODUCT_VERSION_LABEL).toBe('v0.2');
    expect(AUTH_TOKEN_STORAGE_KEY).toBe('slatehub_jwt');
  });

  it('brands the static document title', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    expect(html).toContain('<title>SlateHub · 墨笺</title>');
  });
});
```

- [ ] **Step 2: Change the simulator filename expectations**

Update `simulator-frame.test.ts` to expect:

```ts
'slatehub-group-1-04-content-1-virtual-mono-296x128-etag-ready.png'
```

- [ ] **Step 3: Run the focused Web tests and confirm they fail**

Run:

```bash
bun test frontend/src/app/brand.test.ts frontend/src/features/simulator/lib/simulator-frame.test.ts
```

Expected: FAIL because `brand.ts`, the new storage key and new PNG prefix do not exist.

- [ ] **Step 4: Implement centralized visible-brand constants**

Create `frontend/src/app/brand.ts`:

```ts
export const PRODUCT_NAME = 'SlateHub';
export const PRODUCT_TAGLINE = '案头那块墨水屏';
export const PRODUCT_VERSION_LABEL = 'v0.2';
```

Use these constants in `Layout.tsx` and `AuthLayout.tsx`, preserving all Mono Press class names and layout behavior. Change the static HTML title, device-binding comment, footer copy, and simulator export prefix. Set `AUTH_TOKEN_STORAGE_KEY = 'slatehub_jwt'` with no read/migration of the retired key; users will log in again after upgrade.

- [ ] **Step 5: Run Web tests, typecheck, lint and production build**

Run:

```bash
bun test frontend/src/app/brand.test.ts frontend/src/features/simulator/lib/simulator-frame.test.ts
bun run --cwd frontend typecheck
bun run --cwd frontend lint
bun run --cwd frontend build
```

Expected: all pass; `frontend/dist/index.html` contains `SlateHub · 墨笺`; simulator PNG downloads start with `slatehub-`.

- [ ] **Step 6: Commit the Web identity change**

```bash
git add frontend/index.html frontend/src
git commit -m $'feat(frontend): 更新 SlateHub Web 品牌\n\n- 统一导航、认证页和文档标题\n- 断代浏览器登录存储键\n- 更新模拟器 PNG 导出名称'
```

### Task 4: Firmware Build Configuration, Captive Portal, and NVS Identity

**Files:**
- Modify: `firmware/CMakeLists.txt`
- Modify: `firmware/main/CMakeLists.txt`
- Modify: `firmware/main/Kconfig.projbuild`
- Modify: `firmware/main/app/app.cc`
- Modify: `firmware/main/bsp/board_platform.cc`
- Modify: `firmware/main/network/captive_portal.cc`
- Modify: `firmware/main/network/captive_portal.h`
- Modify: `firmware/main/network/cred_store.h`
- Modify: `firmware/main/network/sntp.cc`
- Modify: `firmware/main/network/wifi.cc`
- Modify: `firmware/main/resources/captive_portal_html.cc`
- Modify: `firmware/main/resources/captive_portal_html.h`
- Modify: `firmware/main/scenes/splash/splash_scene.cc`
- Modify: `firmware/main/storage/nvs/nvs_schema.h`
- Modify: `firmware/main/storage/nvs/volume_store.h`
- Modify: `firmware/main/storage/cache/cache_paths.cc`
- Modify: `firmware/main/storage/cache/cache_staging.cc`
- Modify: `firmware/main/storage/cache/cache_staging.h`
- Modify: `firmware/main/update/firmware_offer.cc`
- Modify: `firmware/main/xiaozhi/config/activation_client.cc`
- Modify: `firmware/main/xiaozhi/mcp/mcp_dispatcher.cc`
- Modify: `firmware/host_tests/CMakeLists.txt`

**Interfaces:**
- Consumes: board id `zectrix-note4`, ESP-IDF Kconfig and NVS maximum name size 16 including terminator.
- Produces: ESP-IDF project/binary `slatehub`, macros `CONFIG_SLATEHUB_*` / `SLATEHUB_*`, SoftAP `SlateHub-XXXX`, namespace `slatehub::*`, and only the five approved NVS namespaces.

- [ ] **Step 1: Write compile-time assertions for exactly the new NVS namespaces**

Replace the namespace constants in `nvs_schema.h` with:

```cpp
inline constexpr char kNet[]         = "slatehub.net";
inline constexpr char kAudio[]       = "slatehub.audio";
inline constexpr char kXiaozhi[]     = "slatehub.xiao";
inline constexpr char kXiaozhiMqtt[] = "slatehub.x.mq";
inline constexpr char kXiaozhiWs[]   = "slatehub.x.ws";

#define SLATEHUB_NVS_ASSERT_NAME(name) \
    static_assert(::nvs_schema::FitsName(name), #name " exceeds NVS name limit")
```

Delete every legacy namespace constant and its assertion. Add assertions that the five values are unique so a future abbreviation cannot alias another store.

- [ ] **Step 2: Rename host-test compile definitions first**

In `firmware/host_tests/CMakeLists.txt`, change the project and definitions to:

```cmake
project(slatehub_firmware_host_tests LANGUAGES CXX)
target_compile_definitions(display_contract_test PRIVATE "SLATEHUB_BOARD_ID=\"zectrix-note4\"")
target_compile_definitions(cache_staging_test PRIVATE SLATEHUB_HOST_TEST)
```

Apply `SLATEHUB_HOST_TEST` and `SLATEHUB_BOARD_ID` to every other host target.

- [ ] **Step 3: Run the VM host-test compile and confirm it fails**

Run:

```bash
limactl shell slate-build -- bash -lc '
  cd /Users/tomato/Documents/code/slatehub &&
  rm -rf /tmp/slatehub-host-tests-plan &&
  cmake -S firmware/host_tests -B /tmp/slatehub-host-tests-plan -G Ninja &&
  cmake --build /tmp/slatehub-host-tests-plan
'
```

Expected: FAIL because firmware sources still reference `SLATE_HOST_TEST` / `SLATE_BOARD_ID`.

- [ ] **Step 4: Rename ESP-IDF project and Kconfig symbols**

Set `project(slatehub)` and change all Kconfig symbols to:

```text
SLATEHUB_BOARD_ID
SLATEHUB_DEFAULT_SERVER_URL
SLATEHUB_AP_SSID_PREFIX
SLATEHUB_DEFAULT_TIMEZONE
SLATEHUB_IDLE_DEEP_SLEEP_MIN
```

The AP default is `SlateHub`. `firmware/main/CMakeLists.txt` must reject unsupported `CONFIG_SLATEHUB_BOARD_ID` and define `SLATEHUB_BOARD_ID` for C++ sources. Rename every source conditional from `SLATE_HOST_TEST` to `SLATEHUB_HOST_TEST` and every board macro read from `SLATE_BOARD_ID` to `SLATEHUB_BOARD_ID`, including cache and OTA sources that Task 5 will modify again for their value-level protocol changes. Do not define the retired macros as aliases.

- [ ] **Step 5: Rename firmware namespaces and visible portal identity**

Rename C++ namespace `slate` in captive portal resources to `slatehub`, update callers, and set visible strings to:

```html
<title>SlateHub · 配网</title>
<h1 class="brand">SlateHub<span class="brand-dot">.</span></h1>
<input placeholder="https://slatehub.your-domain.com">
<span>slatehub · v0.2.0</span>
```

Use `CONFIG_SLATEHUB_AP_SSID_PREFIX` in both splash and captive portal. Add an informational Wi-Fi log after AP start:

```cpp
ESP_LOGI(kTag, "ap started ssid=%s", ssid);
```

This log is the machine-verifiable acceptance signal for `SlateHub-2BDC`.

- [ ] **Step 6: Rename NVS users and external device identity**

Update all stores/comments to the new namespace constants, set Xiaozhi application fallback and MCP `serverInfo.name` to `slatehub`, and update the idle timeout/timezone config reads. There must be no migration loop or legacy namespace lookup.

- [ ] **Step 7: Rebuild the host test targets**

Run:

```bash
limactl shell slate-build -- bash -lc '
  cd /Users/tomato/Documents/code/slatehub &&
  cmake -S firmware/host_tests -B /tmp/slatehub-host-tests-plan -G Ninja &&
  cmake --build /tmp/slatehub-host-tests-plan
'
```

Expected: build succeeds with only `SLATEHUB_*` definitions.

- [ ] **Step 8: Commit the firmware identity boundary**

```bash
git add firmware/CMakeLists.txt firmware/main firmware/host_tests/CMakeLists.txt
git commit -m $'feat(firmware): 断代 SlateHub 配置与持久化身份\n\n- 重命名工程、Kconfig 和测试宏\n- 切换 SoftAP 与 captive portal 品牌\n- 移除历史 NVS namespace 兼容读取'
```

### Task 5: Firmware OTA, Cache, and Host Contract Rename

**Files:**
- Modify: `firmware/main/update/firmware_offer.cc`
- Modify: `firmware/main/storage/cache/cache_paths.cc`
- Modify: `firmware/main/storage/cache/cache_staging.cc`
- Modify: `firmware/main/storage/cache/cache_staging.h`
- Modify: `firmware/main/sync/sync_service.cc`
- Modify: `firmware/host_tests/firmware_update_contract_test.cc`
- Modify: `firmware/host_tests/cache_staging_test.cc`
- Modify: `firmware/host_tests/cache_integration_test.cc`
- Modify: `firmware/host_tests/sync_current_content_transaction_test.cc`

**Interfaces:**
- Consumes: Task 1 OTA metadata contract and Task 4 `SLATEHUB_BOARD_ID` / `SLATEHUB_HOST_TEST` definitions.
- Produces: OTA parser accepting only `product: "slatehub"` and `slatehub-{board}-{tag}-ota.bin`; host cache root `SLATEHUB_CACHE_ROOT`; journal magic `slatehub-cache-stage-v1`.

- [ ] **Step 1: Rewrite OTA positive fixtures and preserve rejection coverage**

In `firmware_update_contract_test.cc`, make the helper defaults:

```cpp
const char* url = "https://updates.example/slatehub-zectrix-note4-v0.2.0-ota.bin";
const char* filename = "slatehub-zectrix-note4-v0.2.0-ota.bin";
const char* product = "slatehub";
```

Add a rejection case using adjacent string literals so the retired value does not become an allowed operational token:

```cpp
CHECK(Read(OfferJson("zectrix-note4", url, filename, kSha256Abc, "3", 1,
                     "s" "late"))
          .error == firmware_update::OfferError::kInvalidMetadata);
```

- [ ] **Step 2: Update cache tests before implementation**

Change temporary roots, environment control and journal fixtures to:

```cpp
setenv("SLATEHUB_CACHE_ROOT", root_.c_str(), 1);
constexpr char kExpectedJournalMagic[] = "slatehub-cache-stage-v1";
```

Add one test that writes the retired journal magic from joined fragments and verifies recovery rejects/removes it rather than resuming an incompatible transaction.

- [ ] **Step 3: Run CTest and confirm failures**

Run:

```bash
limactl shell slate-build -- bash -lc '
  cd /Users/tomato/Documents/code/slatehub &&
  cmake -S firmware/host_tests -B /tmp/slatehub-host-tests -G Ninja &&
  cmake --build /tmp/slatehub-host-tests &&
  ctest --test-dir /tmp/slatehub-host-tests --output-on-failure
'
```

Expected: OTA and cache-related tests fail because production code still accepts/produces retired values.

- [ ] **Step 4: Implement the OTA and cache break**

In `firmware_offer.cc` require:

```cpp
if (JsonString(firmware, "product") != "slatehub")
    return Result::Failure(OfferError::kInvalidMetadata);

const std::string expected_filename =
    "slatehub-" + offer->board_id_ + "-" + offer->release_tag_ + "-ota.bin";
```

Rename all host macros/environment variables, default host cache paths, staging magic and FreeRTOS sync task name to `slatehub`. No old journal compatibility is retained because the full flash clears storage.

- [ ] **Step 5: Run all firmware host tests**

Run:

```bash
limactl shell slate-build -- bash -lc '
  cd /Users/tomato/Documents/code/slatehub &&
  cmake -S firmware/host_tests -B /tmp/slatehub-host-tests -G Ninja &&
  cmake --build /tmp/slatehub-host-tests &&
  ctest --test-dir /tmp/slatehub-host-tests --output-on-failure
'
```

Expected: every host test passes; old product and old journal fixtures are rejected.

- [ ] **Step 6: Commit the firmware protocol change**

```bash
git add firmware/main/update firmware/main/storage/cache firmware/main/sync \
  firmware/host_tests/firmware_update_contract_test.cc \
  firmware/host_tests/cache_staging_test.cc firmware/host_tests/cache_integration_test.cc \
  firmware/host_tests/sync_current_content_transaction_test.cc
git commit -m $'feat(firmware): 断代 SlateHub OTA 与缓存契约\n\n- 仅接受 SlateHub product 和附件名\n- 更新 host cache 配置与事务日志魔数\n- 保留旧协议拒绝回归测试'
```

### Task 6: Documentation, Acknowledgement, Hero Image, and Brand Guard

**Files:**
- Create: `NOTICE.md`
- Create: `tools/check-brand-contract.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `README.md`
- Modify: `backend/README.md`
- Modify: `backend/scripts/README.md`
- Modify: `frontend/README.md`
- Modify: `shared/README.md`
- Modify: `firmware/README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `AGENTS.md`
- Modify: `readme-hero.png`

**Interfaces:**
- Consumes: names and commands established in Tasks 1-5.
- Produces: self-hosting/NAS instructions for `JikeStardy/slatehub`; a two-location upstream acknowledgement; `bun run check:brand-contract`.

- [ ] **Step 1: Create the repository-wide brand guard**

`tools/check-brand-contract.mjs` must enumerate both tracked and untracked non-ignored files with:

```js
const listed = spawnSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8' }
);
```

For text source/config/document extensions, skip `docs/superpowers/`, permit acknowledgement terms in only `README.md` and `NOTICE.md`, and fail on:

```js
const retiredLower = ['s', 'late'].join('');
const retiredTitle = `S${retiredLower.slice(1)}`;
const retiredWord = new RegExp(
  `(^|[^A-Za-z])(?:${retiredTitle}|${retiredLower})(?=$|[^A-Za-z])`
);
const retiredPrefix = new RegExp(`\\b${['S', 'LATE_'].join('')}`);
const upstreamUrl = ['https://github.com/', 'qiujun8023/', retiredLower].join('');
```

Also fail when a path itself contains the retired standalone word, and assert required current values in `compose.yml`, workflows, firmware Kconfig, metadata schema, Web title and READMEs. Print each violation as `path: reason` and exit 1.

- [ ] **Step 2: Wire the brand guard into package and CI**

Add:

```json
"check:brand-contract": "node tools/check-brand-contract.mjs"
```

Run it from both `.github/workflows/ci.yml` and the release quality-gate job before any image/firmware publishing step.

- [ ] **Step 3: Run the guard and confirm it reports the remaining documentation surfaces**

Run: `bun run check:brand-contract`

Expected: FAIL with an explicit list covering root/module READMEs, `AGENTS.md`, `CONTRIBUTING.md`, and any source surface missed by Tasks 1-5.

- [ ] **Step 4: Rewrite documentation and deployment examples**

Update every command, tree label, environment variable, image, service, database, firmware filename and download URL to its Task 1-5 name. Root NAS quick start must download from:

```text
https://github.com/JikeStardy/slatehub/releases/latest/download/compose.yml
https://github.com/JikeStardy/slatehub/releases/latest/download/slatehub.env.example
```

Document that `master` is the pre-release/default Compose channel, stable deployment should pin `v0.2.0` or use `latest` after release, and private GHCR packages require `docker login ghcr.io` with `read:packages`. Do not claim a GitHub Release or image already exists.

- [ ] **Step 5: Add the explicit upstream acknowledgement**

Create `NOTICE.md` with:

```markdown
# Notice

SlateHub is based on the Slate project and continues under the repository's MIT License.

Original project: https://github.com/qiujun8023/slate

Thank you to the original author and contributors for the foundation on which SlateHub evolved.
```

Add a Chinese “致谢与项目来源” section to the root README carrying the same single source URL. These are acknowledgements only; no instructions may pull an image, binary or source archive from that repository.

- [ ] **Step 6: Edit and inspect the README hero image**

Use the image-editing tool with `readme-hero.png` as the referenced image and this constrained instruction:

```text
Keep the canvas size, cream paper background, black line-art dashboard, device cards,
Chinese labels, spacing, iconography and accent-red marks unchanged. Replace only the two
visible English brand labels “Slate” (large top-left and small dashboard masthead) with
“SlateHub”, matching the existing black serif typography and baseline. Do not add or remove
any other element.
```

Inspect the result at original resolution. Acceptance: both labels read `SlateHub`, no old label remains, all Chinese glyphs and fine 1px lines remain sharp, dimensions remain `1677 × 941`.

- [ ] **Step 7: Run the brand and documentation checks**

Run:

```bash
bun run check:brand-contract
bun run format:check
git diff --check
```

Expected: all exit 0. An explicit search may find retired terms only in `README.md`, `NOTICE.md`, negative fixtures assembled from fragments, and the excluded `docs/superpowers/` decision records.

- [ ] **Step 8: Commit documentation and the permanent guard**

```bash
git add NOTICE.md README.md backend/README.md backend/scripts/README.md frontend/README.md \
  shared/README.md firmware/README.md CONTRIBUTING.md AGENTS.md readme-hero.png \
  tools/check-brand-contract.mjs package.json .github/workflows/ci.yml \
  .github/workflows/release.yml
git commit -m $'docs(brand): 完成 SlateHub 全仓断代改名\n\n- 更新自托管、开发和固件文档\n- 保留原项目致谢与 MIT 来源说明\n- 增加生产面品牌与上游依赖守卫'
```

### Task 7: Full Automated Verification and Review Gates

**Files:**
- Modify only when a failing check or reviewer finding requires a scoped fix.
- Do not commit generated `frontend/dist/`, ESP-IDF `firmware/build/`, Docker layers, VM packages or temporary logs.

**Interfaces:**
- Consumes: all Tasks 1-6 commits.
- Produces: green Bun/TypeScript/Release/C++/ESP-IDF/Docker evidence and independent code-review approval.

- [ ] **Step 1: Run the complete repository quality gate**

Run on the host with already-installed Bun/Node:

```bash
bun run format:check
bun run lint
bun run typecheck
bun run --cwd backend test
bun test
bun run --cwd frontend build
bun run check:release-contract
bun run test:release-metadata
bun run check:brand-contract
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Build and run all firmware host tests inside the VM**

```bash
limactl shell slate-build -- bash -lc '
  set -euo pipefail
  cd /Users/tomato/Documents/code/slatehub
  rm -rf /tmp/slatehub-host-tests-final
  cmake -S firmware/host_tests -B /tmp/slatehub-host-tests-final -G Ninja
  cmake --build /tmp/slatehub-host-tests-final
  ctest --test-dir /tmp/slatehub-host-tests-final --output-on-failure
'
```

Expected: configure/build succeed and every CTest passes.

- [ ] **Step 3: Build Note4 firmware and merged images with ESP-IDF 5.5.2 in the VM**

```bash
limactl shell slate-build -- bash -lc '
  set -euo pipefail
  source /home/tomato.guest/esp-idf-v5.5.2/export.sh
  cd /Users/tomato/Documents/code/slatehub
  printf "CONFIG_SLATEHUB_BOARD_ID=\"zectrix-note4\"\n" > /tmp/slatehub-zectrix-note4.defaults
  idf.py -C firmware fullclean
  idf.py -C firmware -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;/tmp/slatehub-zectrix-note4.defaults" build
  idf.py -C firmware -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;/tmp/slatehub-zectrix-note4.defaults" \
    merge-bin -o slatehub-zectrix-note4-v0.2.0-full.bin
  cp firmware/build/slatehub.bin firmware/build/slatehub-zectrix-note4-v0.2.0-ota.bin
  sha256sum firmware/build/slatehub-zectrix-note4-v0.2.0-{full,ota}.bin
'
```

Expected: ESP-IDF reports v5.5.2, project `slatehub`, version `0.2.0`, 16MB QIO flash and 8MB Octal PSRAM configuration; both files exist and have non-zero SHA-256 values.

- [ ] **Step 4: Install Docker only inside the VM and validate Compose/image build**

If `/usr/bin/docker` is absent, run only in `slate-build`:

```bash
limactl shell slate-build -- bash -lc '
  sudo apt-get update &&
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2
'
```

Then run:

```bash
limactl shell slate-build -- bash -lc '
  set -euo pipefail
  cd /Users/tomato/Documents/code/slatehub
  install -d /tmp/slatehub-compose-check
  cp compose.yml /tmp/slatehub-compose-check/compose.yml
  cp .env.example /tmp/slatehub-compose-check/.env
  cd /tmp/slatehub-compose-check
  SLATEHUB_IMAGE=ghcr.io/jikestardy/slatehub:test sudo -E docker compose config >/tmp/slatehub-compose.yml
  cd /Users/tomato/Documents/code/slatehub
  sudo docker build -t slatehub:test .
  sudo docker image inspect slatehub:test --format "{{.Id}} {{.Architecture}}"
'
```

Expected: Compose resolves service/database/data paths to SlateHub names and the image builds successfully. Do not install Docker or Compose on macOS.

- [ ] **Step 5: Run mandatory independent reviews**

Invoke a fresh `code-reviewer` over all commits after `5a655cc`, explicitly checking deployment, TypeScript, release workflows and absence of upstream runtime dependencies. Invoke a fresh `cpp-reviewer` over all modified firmware/CMake files, explicitly checking macro consistency, NVS length, OTA rejection behavior, memory safety and ESP-IDF compatibility.

Expected: no unresolved P0/P1/P2 findings. Apply any valid fixes, rerun the smallest affected tests, then rerun Steps 1-3 before continuing.

- [ ] **Step 6: Commit review fixes if any**

If review produced changes, create one scoped commit:

```bash
git diff --name-only --diff-filter=ACMRTUXB -z | xargs -0 git add --
git commit -m $'fix(brand): 修正 SlateHub 断代评审问题\n\n- 处理独立代码与固件评审发现\n- 保持发布、部署和设备契约一致'
```

If no files changed, do not create an empty commit.

### Task 8: Destructive Full Reflash and Note4 Acceptance

**Files:**
- Read: `firmware/build/slatehub-zectrix-note4-v0.2.0-full.bin`
- Temporary: `/private/tmp/slatehub-note4-flash/`
- No repository files are modified.

**Interfaces:**
- Consumes: verified full image from Task 7 and the currently attached ESP32-S3 Note4.
- Produces: erased/reflashed device with first-boot portal, `SlateHub-2BDC`, and serial evidence for project/version/hardware/display health.

- [ ] **Step 1: Resolve and identify exactly one serial target**

Run:

```bash
PORTS=(/dev/cu.usbmodem*)
test "${#PORTS[@]}" -eq 1
NOTE4_PORT="${PORTS[1]}"
uvx --from esptool==5.4.0 esptool --chip esp32s3 --port "$NOTE4_PORT" chip-id
```

Expected: one port, chip `ESP32-S3`, revision `0.2`, MAC ending `2b:dc`. Stop before erase if the chip identity differs.

- [ ] **Step 2: Copy the verified VM artifact to a host temporary directory**

Because the repository is mounted into both host and VM, copy without installing ESP-IDF locally:

```bash
mkdir -p /private/tmp/slatehub-note4-flash
cp firmware/build/slatehub-zectrix-note4-v0.2.0-full.bin \
  /private/tmp/slatehub-note4-flash/
shasum -a 256 /private/tmp/slatehub-note4-flash/slatehub-zectrix-note4-v0.2.0-full.bin
```

Expected: SHA-256 matches Task 7 exactly.

- [ ] **Step 3: Erase the entire device flash**

This is intentionally destructive and is already authorized by the approved spec:

```bash
uvx --from esptool==5.4.0 esptool --chip esp32s3 --port "$NOTE4_PORT" erase-flash
```

Expected: `Chip erase completed successfully`. This removes the old NVS, cache and application state.

- [ ] **Step 4: Write and verify the merged image from offset `0x0`**

```bash
uvx --from esptool==5.4.0 esptool --chip esp32s3 --port "$NOTE4_PORT" \
  --baud 460800 write-flash 0x0 \
  /private/tmp/slatehub-note4-flash/slatehub-zectrix-note4-v0.2.0-full.bin
```

Expected: esptool reports compressed write completion and hash verification success.

- [ ] **Step 5: Capture first-boot UART evidence**

Run for up to 60 seconds:

```bash
uvx --from pyserial==3.5 pyserial-miniterm "$NOTE4_PORT" 115200 \
  --raw --exit-char 3 | tee /private/tmp/slatehub-note4-flash/boot.log
```

Expected log evidence:

```text
Project name:     slatehub
App version:      0.2.0
... QIO ... 80MHz ...
... 8MB ... PSRAM ...
boot decision mode=portal ... first_register=1
ap started ssid=SlateHub-2BDC
... full refresh ... done ...
```

There must be no panic, abort, Guru Meditation, partition error or PSRAM failure.

- [ ] **Step 6: Inspect the physical screen and captive portal**

Verify the screen shows the SlateHub pairing/configuration identity without inversion, corruption or obvious ghosting. Connect to `SlateHub-2BDC` and open `http://192.168.4.1`; verify title/heading/footer are SlateHub and the server placeholder uses `slatehub.your-domain.com`. Do not submit credentials unless the user supplies the target NAS URL.

- [ ] **Step 7: Clean temporary host artifacts after evidence is recorded**

Remove only the task-specific directory after copying the SHA/log summary into the final response:

```bash
trash /private/tmp/slatehub-note4-flash
```

If `trash` is unavailable, leave the directory in place and report its path instead of using recursive deletion.

- [ ] **Step 8: Final local-state audit**

Run:

```bash
git status --short
git log --oneline --decorate -8
git rev-list --count origin/master..HEAD
```

Expected: worktree clean, all rename commits present locally, and no GitHub push/tag/release performed. Final report must include test/build evidence, Docker/Compose result, full-image SHA-256, serial port/chip identity, write verification, boot evidence, and the explicit remaining step that GitHub publication still requires user authorization/authentication.
