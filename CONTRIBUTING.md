# 贡献指南

欢迎 issue 与 PR。本文档说明协作流程；环境搭建与架构信息见 [README.md](README.md) 与各子目录的 README。

## 报告 Bug

提 issue 时请包含：

- **复现步骤** —— 一步步可执行的最小操作序列
- **期望行为** vs **实际行为**
- **环境** —— 三端独立编号：
  - 固件：`fw_version`（设置 → 设备信息），或 commit hash
  - 后端：commit hash + Bun 版本 + MySQL 版本
  - 前端：commit hash + 浏览器版本
- **日志** —— 后端日志（`docker compose logs slatehub`）、固件 UART log（`idf.py monitor`）、浏览器 Console，按需贴出关键片段

## 提交 PR

### 分支与提交

- 从 `master` 切分支，名字简短描述意图（`fix-frame-reorder`、`feat-bulk-upload`）
- 一个 PR 只解决一件事；不相干的清理拆 PR

### Commit message

跟随仓库现有风格（Conventional Commits）：

```
<type>(<scope>): <简短中文描述>

可选：详细说明
```

`type` 取值：`feat` / `fix` / `refactor` / `style` / `chore` / `docs` / `test`。`scope` 取自三端或细分模块：`auth` / `frames` / `devices` / `firmware` / `docker` / `frontend` / `backend` 等。

参考最近 commit：

```
fix(auth): 补全 guard 本地 JwtPayload 的 username 字段
fix(docker): 删除 VOLUME 声明，避免匿名卷遮蔽 compose bind mount
feat: 支持用户名登录 + 注册时填用户名，修复新建组回车提交
refactor: 轮询间隔由设备端本地决策，后端移除服务端下发配置
```

### 提交前必跑

```bash
bun run format:check     # Prettier
bun run lint             # ESLint，零 warning
bun run typecheck        # tsc --noEmit
bun run --cwd backend test
```

格式问题用 `bun run format` 自动修复。CI 会再跑一遍同一组命令；本地通过基本就能过 CI。

### 固件改动

固件 PR 需要本地 ESP-IDF 5.5.x 构建通过：

```bash
source $IDF_PATH/export.sh
idf.py -C firmware build
```

CI 上 `firmware.yml` 用 v5.5.2 跑构建。涉及 EPD / 电源 / 按键 / 休眠等硬件交互的改动，请在 PR 描述里说明：

- 实机验证了什么场景（开机 / 翻页 / 切相册 / 充电 / 深睡唤醒）
- 是否影响 partition 布局 / NVS 字段（影响则必须保证 OTA 升级路径）

## 设计与 UX 改动

涉及 frontend UI 的改动：

- 颜色 / 圆角 / 字体只走 `frontend/src/styles/global.css` 的 `@theme` token，不写裸十六进制
- Mono Press 设计语言：0px 圆角、宋体标题、`#a8281c` 砖红仅用于危险态
- 改前先看 [frontend/README.md](frontend/README.md#设计系统-mono-press) 的设计原则

## 发布版本

SlateHub 使用单一产品版本号。一个 `vX.Y.Z` tag 同时发布生产 Docker 镜像和固件产物；不要为 backend 和 firmware 拆成两个 release。

发布前同步以下版本号，必须全部等于 tag 去掉 `v` 后的版本：

- 根 `package.json`
- `backend/package.json`
- `frontend/package.json`
- `shared/package.json`
- `bun.lock` 中 workspace package 的版本记录
- `firmware/sdkconfig.defaults` 的 `CONFIG_APP_PROJECT_VER`

更新 package 版本后运行一次 `bun install`，让 `bun.lock` 同步 workspace 版本。

发布使用 annotated tag，tag body 会被 CI 作为 GitHub Release notes：

```bash
git tag -a v0.2.0
git push origin v0.2.0
```

tag message 示例：

```text
SlateHub v0.2.0

- 后端 / Web：新增 ...
- 固件：修复 ...
- 兼容性：推荐固件 v0.2.0
```

推送 tag 后，`release.yml` 会自动完成校验、Docker 镜像推送、固件构建、GitHub Release 创建，并上传固件、sha256、部署用 `compose.yml` / env 示例。给本地 AI 代理执行发版时，请让它同时遵守 [AGENTS.md](AGENTS.md) 的发布规则。
