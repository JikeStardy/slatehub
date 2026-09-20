# SlateHub 全量断代改名设计

日期：2026-09-21

## 目标

将当前产品、部署单元、固件工程和发布协议从 `Slate` / `slate` 完整改名为
`SlateHub` / `slatehub`，移除对原上游仓库及镜像的构建、发布和运行时依赖。
本次改名明确采用不兼容迁移：不保留旧 OTA 产品标识、旧产物名称、旧环境变量或旧
NVS namespace 的兼容读取。当前 ZecTrix Note4 将在改名完成后使用完整镜像从 offset
`0x0` 重新烧录。

原项目只作为历史来源受到致谢。上游链接不得继续出现在运行时请求、部署文件、镜像、
下载地址或发布流程中。

## 成功标准

1. 用户可见品牌统一为 `SlateHub`，小写机器标识统一为 `slatehub`。
2. GitHub、GHCR、Docker Compose、发布附件和文档下载地址全部指向
   `JikeStardy/slatehub` 及 `ghcr.io/jikestardy/slatehub`。
3. 固件工程、配置项、NVS namespace、SoftAP、OTA metadata 和产物名称不再产生或接受
   旧 `slate` 标识。
4. 全仓仅允许在 README 致谢段落和 `NOTICE.md` 中出现
   `github.com/qiujun8023/slate`。
5. 软件测试、发布契约、Docker Compose 校验和 ESP-IDF 5.5.2 构建全部通过。
6. Note4 完整重刷后，以 `SlateHub-2BDC` 进入首次配网，启动、PSRAM、QIO 和墨水屏全刷
   均通过实机验证。

## 命名规范

| 语境 | 新名称 |
| --- | --- |
| 产品品牌 | `SlateHub` |
| 机器标识、根 package | `slatehub` |
| GitHub 仓库 | `JikeStardy/slatehub` |
| GHCR 镜像 | `ghcr.io/jikestardy/slatehub` |
| Compose 服务 / 容器 | `slatehub`, `slatehub-mysql` |
| 默认数据库 / 用户 | `slatehub` |
| 数据目录 | `./slatehub`, `./mysql` |
| 固件工程 / app binary | `slatehub`, `slatehub.bin` |
| 固件配置前缀 | `SLATEHUB_`, `CONFIG_SLATEHUB_` |
| 后端 job 环境变量前缀 | `SLATEHUB_` |
| SoftAP | `SlateHub-XXXX` |
| OTA product | `slatehub` |
| 发布附件前缀 | `slatehub-{board_id}-...` |

已有且不表达产品身份的标识保持不变：`zectrix-note4`、DisplayProfile id、`/api/v2`、
协议版本 `2`、数据库表名以及 `backend` / `frontend` / `shared` workspace 名称。

## 仓库与部署独立性

Docker 和 Release workflow 继续从 `github.repository_owner` 派生 owner，但镜像仓库名改为
`slatehub`。根 `compose.yml` 默认使用
`ghcr.io/jikestardy/slatehub:master`，并允许通过 `SLATEHUB_IMAGE` 覆盖；首个稳定版本发布后，
文档推荐将其切换为 `latest` 或固定的 `vX.Y.Z`。

Compose 中服务名、容器名、MySQL database/user、数据目录和内部 `DATABASE_URL` 全部改为
`slatehub`。这是新安装配置，不提供旧 volume 或旧数据库名的自动迁移。NAS 部署文档必须
说明 GHCR package 需要设为 public，或者使用具有 `read:packages` 权限的 token 登录。

README 的 Release 下载链接、后端外部请求 User-Agent、脚本示例和所有部署片段必须指向
当前仓库。任何生产路径均不得下载或运行上游镜像和上游 Release 资产。

## 固件与 OTA 断代

ESP-IDF `project()` 改为 `slatehub`，构建产物相应改为 `slatehub.bin`。Kconfig symbol、
编译定义、host-test 宏和测试环境变量统一采用 `SLATEHUB` 前缀，不提供旧前缀 alias。

NVS namespace 采用不超过 ESP-IDF 15 字节限制的新名称：

- `slatehub.net`
- `slatehub.audio`
- `slatehub.xiao`
- `slatehub.x.mq`
- `slatehub.x.ws`

旧 `slate.*` 和历史 `slate.chat*` namespace 定义及迁移读取全部删除。完整重刷会清除当前
设备上的旧 NVS，随后设备重新进入 captive portal。

OTA metadata schema 的 `product` 常量改为 `slatehub`。生成器、验证器、固件解析器和
host tests 只接受以下新格式：

- `slatehub-{board_id}-vX.Y.Z-full.bin`
- `slatehub-{board_id}-vX.Y.Z-ota.bin`
- `slatehub-{board_id}-vX.Y.Z-ota.json`
- `slatehub-{board_id}-vX.Y.Z-sha256.txt`

不生成旧名称 alias，也不接受 `product: "slate"`。当前已刷入的旧固件因此不能通过 OTA
跨越这次改名，必须执行一次 USB 完整烧录；这是本设计明确接受的破坏性边界。

## 用户界面与静态资产

Web 标题、导航品牌、认证页、页脚、设备文案、captive portal HTML、固件设置菜单和日志中的
产品名统一为 `SlateHub`。默认 AP 前缀改为 `SlateHub`。

`readme-hero.png` 中可见的 `Slate` 品牌也必须更新，避免文档文字完成改名但主视觉仍保留旧
名称。图像布局和 Mono Press 视觉语言保持不变，只替换品牌文字并检查导出清晰度。

## 致谢与许可证

保留现有 MIT License。新增 `NOTICE.md`，并在 README 增加“致谢与项目来源”段落，说明：

- SlateHub 基于 Slate 项目演进；
- 原项目地址为 `https://github.com/qiujun8023/slate`；
- 感谢原作者和贡献者。

这两个位置是上游 URL 的唯一允许项。致谢不意味着镜像、Release、代码下载或运行时服务仍
依赖上游。

## 发布与版本

改名后的下一个预发布目标版本为 `0.2.0`，但本次实现不会在未经明确授权时创建或推送
tag。
实施时同步更新根、backend、frontend、shared package 版本、`bun.lock` workspace 记录和
`CONFIG_APP_PROJECT_VER`，确保未来 `v0.2.0` 发布契约可通过。

推送 `master` 后，CI 应产出 `ghcr.io/jikestardy/slatehub:master`。稳定 `latest`、`v0.2.0`
和 `0.2` 标签只由 annotated `v0.2.0` tag 的 release workflow 生成。

## 验证策略

### 静态契约

- 扫描 `Slate`、`slate`、`SLATE_` 和 `qiujun8023`，逐项确认无遗漏。
- 上游 URL 只允许位于 README 致谢和 `NOTICE.md`。
- release contract 必须拒绝旧 product、旧附件前缀和旧镜像名。
- 检查 README 主视觉及 Web/captive portal 可见品牌。

### 软件验证

- `bun run format:check`
- `bun run lint`
- `bun run typecheck`
- `bun run --cwd backend test`
- `bun test` 覆盖 shared/frontend 相关测试
- `bun run --cwd frontend build`
- `bun run check:release-contract`
- `bun run test:release-metadata`
- Docker build 与 `docker compose config`

### 固件验证

- 在 `slate-build` Lima 虚拟机内运行全部 host tests。
- 使用 ESP-IDF 5.5.2 构建 `slatehub.bin`、full 和 OTA 镜像。
- 校验大小、SHA-256、16MB flash 配置、QIO 80MHz 和 8MB Octal PSRAM。
- 通过 USB 将 full 镜像写入 Note4 offset `0x0` 并验证写后 hash。
- 捕获启动日志，确认项目名 `slatehub`、无 panic、全刷完成。
- 肉眼确认屏幕和 `SlateHub-2BDC` captive portal，无花屏、倒置或明显残影。

## 风险与控制

- **旧设备无法 OTA 迁移**：通过本次明确的 USB 全量重刷解决，不提供兼容桥。
- **旧 NAS 数据不可直接复用**：当前尚无 SlateHub 生产部署；文档明确这是新安装。
- **NVS 名称长度限制**：所有新 namespace 由编译期 static assertions 验证。
- **品牌遗漏**：增加自动扫描和 release contract 断言，而不是只依赖人工搜索。
- **上游依赖回流**：CI 检查除两个致谢位置外不得出现上游 URL 或旧 GHCR 镜像。

## 非目标

- 不更改设备 API 路径、业务 schema、board id 或 DisplayProfile id。
- 不迁移旧 NAS volume、旧 MySQL database 或旧 NVS 数据。
- 不保留旧环境变量、旧 OTA metadata 或旧文件名 alias。
- 不在本次改名中新增其他 ESP 板型。
- 不自动创建 GitHub Release 或推送 tag。
