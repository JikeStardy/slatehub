# Slate / Firmware

ESP-IDF 5.5.x 固件，目标芯片 ESP32-S3。当前真实硬件只支持 board id **`zectrix-note4`** / **ZecTrix_Note4_V1.0**（极趣实验室「Ai 便利贴」）：4.2 英寸黑白墨水屏、ES8311 音频、MEMS 麦、3 个按键（确认 / 上 / 下）、单节锂电池。

本目录是独立 ESP-IDF 工程，不属于 Bun workspace。

## 构建与烧录

```bash
source $IDF_PATH/export.sh
printf "CONFIG_SLATE_BOARD_ID=\"zectrix-note4\"\n" > /tmp/slate-zectrix-note4.defaults
idf.py -C firmware -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;/tmp/slate-zectrix-note4.defaults" build
idf.py -C firmware -p <serial> flash monitor
```

CI 使用 ESP-IDF v5.5.2 构建：

```bash
printf "CONFIG_SLATE_BOARD_ID=\"zectrix-note4\"\n" > "$RUNNER_TEMP/sdkconfig.zectrix-note4.defaults"
idf.py -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;$RUNNER_TEMP/sdkconfig.zectrix-note4.defaults" build
idf.py -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;$RUNNER_TEMP/sdkconfig.zectrix-note4.defaults" merge-bin -o slate-zectrix-note4-full.bin
cp build/slate.bin build/slate-zectrix-note4-ota.bin
```

target、Flash、PSRAM、分区表已在 `sdkconfig.defaults` 固化，无需手动 `idf.py set-target`。

> 本地手动构建前需要先创建上例中的临时 defaults 文件；CI 会按 board matrix 自动生成。只设置环境变量不会改变 Kconfig，必须通过 `SDKCONFIG_DEFAULTS` 或等价 IDF 配置路径写入 `CONFIG_SLATE_BOARD_ID`。

## 板型与 DisplayProfile

固件只编译真实 `BoardDefinition` 对应的 board id。当前 Phase 1 matrix 只有 `zectrix-note4`，它对应 shared registry 里的 `zectrix-note4-400x300-mono` DisplayProfile。

`virtual-mono-296x128` 是前后端开发 / 测试 profile，用 HTML Canvas 和 PNG 输出验证渲染字节与像素，不是 ESP-IDF BSP，不能进入 firmware matrix、binary 名称或 GitHub Release。当前真实硬件验证仅覆盖 Note4；virtual 输出不证明物理面板刷新、波形、电源或功耗行为。

新增真实 ESP 屏幕设备时，需要：

1. 在 `shared/src/display-profiles.json` 增加 production-capable DisplayProfile 和真实 BoardDefinition。
2. 在 `firmware/main/bsp/` 增加对应 BoardPlatform、GPIO、电源、显示和能力定义，并让非支持 board id 在 CMake/Kconfig 阶段失败。
3. 在 `.github/workflows/firmware.yml` 与 `release.yml` 的 matrix 增加 board row；产物命名保持 `slate-{board_id}-vX.Y.Z-full.bin`、`slate-{board_id}-vX.Y.Z-ota.bin` 和对应 sha256。

## 工程结构

```text
firmware/
├── CMakeLists.txt
├── partitions.csv              4 MB factory app + 12 MB LittleFS storage
├── sdkconfig.defaults          ESP32-S3 / Flash / PSRAM / PM / TLS / Slate 配置
├── tools/                      字体生成工具
└── main/
    ├── app/                    App 生命周期编排
    ├── bsp/                    板级 GPIO、电源、I2C、EPD、按键、ADC、充电状态
    ├── drivers/
    │   ├── audio/              ES8311 + I2S duplex 音频播放/录音
    │   ├── bus/                I2C 设备封装、总线锁、电源自救 hook
    │   ├── display/            SSD2683/SSD1683-compatible EPD 驱动
    │   └── input/              按键封装
    ├── events/                 boot stage、group sync status、UI 事件与事件总线
    ├── network/                Wi-Fi、SNTP、DNS hijack、captive portal、凭据存储
    ├── power/                  power state、sleep manager、重启/关机、分钟级时钟
    ├── resources/              captive portal HTML 与内置字体
    ├── scenes/                 BootSplash、BgRefresh、Frame、Xiaozhi、Settings 及子页
    ├── startup/                boot mode、首次启动/注册流程
    ├── storage/                LittleFS cache、NVS schema
    ├── sync/                   Slate backend HTTP API client 与 SyncService
    ├── ui/                     状态栏、frame view、menu list、主题
    ├── utils/                  JSON、时间、字节、锁 helper
    └── xiaozhi/                小智配置、协议、MCP、对话服务
```

## 硬件规格

| 项 | 规格 |
| --- | --- |
| MCU | ESP32-S3-WROOM-1 N16R8V，16 MB QIO Flash + 8 MB Octal PSRAM |
| 显示 | 4.2" 黑白 EPD，400 x 300，SSD2683 控制器，命令兼容 SSD1683 |
| 音频 | ES8311 codec，单声道扬声器，MEMS 麦，差分 D 类 PA |
| 传感 | PCF8563 RTC、GT23SC6699 NFC |
| 电源 | 单节 4.2 V 锂电，软锁存主电源，独立 EPD rail 与音频/I2C rail |
| 按键 | GPIO0 确认 / BOOT，GPIO39 上，GPIO18 下 / 开机，EN 硬复位 |
| 接口 | USB-C CDC/JTAG、喇叭座、调试座 |

Flash 是 QIO，PSRAM 是 Octal。`CONFIG_ESPTOOLPY_OCT_FLASH=n` 与 `CONFIG_SPIRAM_MODE_OCT=y` 是正确组合。

## GPIO

```text
GPIO0   KEY_ENTER       确认 + BOOT，低有效
GPIO1   STDBY_H         充电 IC 满电状态
GPIO2   CHRG_L          充电 IC 充电状态
GPIO3   LED_G           绿色 LED，低有效
GPIO4   ADC_BAT         VBAT 1:2 分压
GPIO5   RTC_INT         PCF8563 INT#
GPIO6   EPD_PWR_EN      EPD rail
GPIO7   NFC_FD          NFC 场检测
GPIO8   EPD_BUSY        active-low，低=忙，高=空闲
GPIO9   EPD_NRES
GPIO10  EPD_NDC
GPIO11  EPD_NCS         软件控制 CS
GPIO12  EPD_SCK
GPIO13  EPD_SDA         SPI MOSI
GPIO14  I2S_MCLK
GPIO15  I2S_SCLK
GPIO16  I2S_ASDOUT      MIC DIN
GPIO17  PWR_ON          主电源软锁存，高=保持供电
GPIO18  KEY_DET / PGDN  下键 + 开机反馈
GPIO19  USB_DN
GPIO20  USB_DP
GPIO21  NFC_PWR
GPIO38  I2S_LRCK
GPIO39  KEY_PGUP        上键，非 RTC IO，不能 ext1 唤醒
GPIO42  PA_PWR_EN       AVDD_3V3：音频 + I2C 上拉
GPIO43  TXD0
GPIO44  RXD0
GPIO45  I2S_DSDIN       喇叭 DOUT
GPIO46  PA_CTRL         PA enable，高=出声
GPIO47  I2C_SDA
GPIO48  I2C_SCL
```

GPIO 26-37 被 Octal PSRAM 占用，不能用作普通 GPIO。

## 电源

主电源软锁存：

```text
USB/VBAT -> Q5 PMOS -> VIN -> Buck -> 3V3
              ^
              ├─ SW1 / GPIO18 下键拉低栅极：按住开机
              └─ GPIO17 PWR_ON 自锁：固件拉高后松手不断电
```

三条关键 rail：

| Rail | 控制 | 说明 |
| --- | --- | --- |
| 主电源 | GPIO17 | 拉低会整机断电；deep sleep 前必须 RTC GPIO hold 高 |
| EPD 3V3 | GPIO6 | 关闭后屏幕内容保留，但 controller/电荷泵失效；醒来需完整 init |
| AVDD_3V3 | GPIO42 | 音频供电 + I2C 上拉；任何 I2C 操作前必须打开并 hold |

开机阶段必须等待 GPIO18 松开后再交给按键驱动，否则下键会被误识别为一次普通按键。

## 总线

| 总线 | 端口 | 引脚 | 设备 |
| --- | --- | --- | --- |
| I2C | `I2C_NUM_0` | SDA=47, SCL=48 | ES8311 0x18、PCF8563 0x51、GT23SC6699 0x55 |
| SPI | `SPI3_HOST` | SCK=12, MOSI=13, CS=11, DC=10, RST=9, BUSY=8 | EPD，40 MHz mode 0 |
| I2S | `I2S_NUM_0` | MCLK=14, BCLK=15, WS=38, DIN=16, DOUT=45 | ES8311 duplex |
| ADC | ADC1 CH3 | GPIO4 | VBAT 分压 |

## 分区

[partitions.csv](partitions.csv)：

```text
nvs      0x9000    0x6000
phy_init 0xf000    0x1000
factory  0x10000   0x400000
storage  0x410000  0xBF0000
```

`storage` 是 LittleFS，约 12 MB。按每帧 15 KB image + 可选 PCM 估算，可缓存约数百帧。

## 启动模式

`boot_mode::Decide()` 根据凭据和唤醒原因决定：

| 模式 | 条件 | 行为 |
| --- | --- | --- |
| `kPortal` | 没有 Wi-Fi 凭据 | 启动 SoftAP captive portal |
| `kBackgroundRefresh` | RTC timer 唤醒、已有 device secret、且有缓存内容组 | 后台刷新当前动态帧，完成后继续 deep sleep |
| `kFullActive` | 冷启动、按键唤醒、充电唤醒或其他情况 | 显示 UI，联网同步，允许用户操作 |

`wake_reason` 会随 poll 上报给后端：

```text
timer | button | power_on | charge | other
```

## 启动流程

`App::Init()` 当前顺序：

```text
nvs_flash_init + LittleFS mount
  -> Board::Init()
  -> AudioPlayer::Init()
  -> evt::Init()
  -> xiaozhi::XiaozhiService::Start()
  -> SceneStack::SetContext()
  -> load credentials + boot_mode::Decide()
  -> SleepManager::Init()
  -> StartUiLoop()
  -> AttachInputs()
  -> StartMinuteTick()
  -> StartSleep()
  -> 按 boot mode 启动 captive portal 或 Wi-Fi + SyncService
  -> esp_pm_configure(80-240 MHz DFS)
```

`Run()` 直接删除 main task，让 `ui_loop`、`slate_sync`、`audio_play`、EPD refresh 等后台 task 接管。

## Captive Portal

没有 Wi-Fi 凭据时：

- 启动 SoftAP：`{SLATE_AP_SSID_PREFIX}-{MAC后2字节}`，默认 `Slate-XXXX`。
- DNS hijack 所有查询到 `192.168.4.1`。
- HTTP portal 提供两步表单：Wi-Fi SSID/password 与 backend `server_url`。
- 提交后先 `Wifi::TryConnect()` 验证，再保存 NVS 并重启。

凭据结构：

```cpp
std::string wifi_ssid;
std::string wifi_pwd;
std::string server_url;
std::string device_id;
std::string device_secret;
```

首次配网后 `device_secret` 为空，重启进入注册流程。工厂重置会清空凭据，下次开机重新进入 portal。

## 设备注册与绑定

联网后：

1. SNTP 对时，HTTPS 需要有效系统时间。
2. `api::Init(server_url, mac, device_secret)`。
3. 如果 NVS 没有 `device_secret`，调用：

```text
POST /api/v2/devices
```

4. 请求体会带上 `mac`、`board_id`、`protocol_version: 2` 与 `fw_version`。保存后端返回的 `device_id` 与 64 字符 `device_secret`。
5. 屏幕显示 `pair_code`，等待 Web claim。

后续所有受保护设备 API 都使用：

```text
Authorization: Bearer <device_secret>
```

如果连续 5 次收到 401，固件会投递 `kSecretInvalid`，在 UI 主线程清除 secret 并重启，走重新注册流程。

## 同步协议

`SyncService` 运行在 `slate_sync` task，事件位包括：

- 普通 poll
- 手动 trigger
- next/prev 切组
- timer wake background refresh
- stop

轮询周期：

| 状态 | 周期 |
| --- | --- |
| 已绑定 | 60 秒 |
| 未绑定前 10 分钟 | 10 秒 |
| 未绑定 10-30 分钟 | 30 秒 |
| 未绑定 30 分钟后 | 60 秒 |

poll telemetry：

```json
{
  "telemetry": {
    "battery_pct": 85,
    "rssi_dbm": -56,
    "fw_version": "0.1.0",
    "wake_reason": "timer",
    "current_group": "gid",
    "current_content_seq": 3,
    "current_content_etag": "etag",
    "manifest_etag": "etag"
  }
}
```

同步策略：

- manifest etag 未变：只写当前 state，触发缓存命中 UI。
- manifest etag 变化：`GET /groups/:gid/manifest`，再增量下载缺失 image/audio。
- 每个资源请求带 `If-None-Match`，后端命中返回 304。
- timer wake 且 manifest 未变时，如果后端返回 `current_content`，只更新当前帧。
- 切组调用 `/devices/current/group/next` 或 `/prev`，然后同步目标组。

## LittleFS 缓存

布局：

```text
/littlefs/state.json
/littlefs/groups/{gid}/manifest.json
/littlefs/groups/{gid}/frames/{idx}.img
/littlefs/groups/{gid}/frames/{idx}.img.etag
/littlefs/groups/{gid}/frames/{idx}.pcm
/littlefs/groups/{gid}/frames/{idx}.pcm.etag
/littlefs/groups/{gid}/frames/{idx}.meta
```

`FrameMeta` 包含：

```cpp
status_bar_text
content_etag
image_etag
audio_etag
has_ttl
ttl_sec
profile_id
width
height
pixel_format
frame_codec
byte_length
```

这些 identity 字段必须与当前 `DisplayInfo` 的 frame descriptor 一致；缺失或不匹配时固件把缓存视为 miss，避免跨设备或跨 profile 复用旧帧。

完整 manifest 同步使用 per-group staging area：

1. `BeginFrameStage(gid)`
2. 下载所有缺失 image/audio 到 stage
3. 写 staged meta
4. 全部成功后逐帧 `CommitStagedFrame`
5. 安装 manifest swap
6. 写 state
7. state 成功后 finalize swap 备份，再清理旧帧与旧音频

这样普通 I/O 失败不会把已提交缓存写成半更新状态；state 写入前失败会回滚已安装的 frame/audio/meta/manifest swap。当前没有 durable journal，若设备在 rename 序列中掉电，可能留下 `.bak` 或 staged artifact，后续需要专门的恢复扫描任务处理。同步后会按空闲空间和组数量清理旧组，当前配置为至少保留 1 MB，最多缓存 4 个组。

## UI 与按键

唯一 UI 消费者是 `ui_loop` task。事件通过 FreeRTOS queue 传递，`UiEvent` 必须保持 trivially-copyable，不允许放 `std::string` 或 owning 容器。

按键：

| 操作 | 行为 |
| --- | --- |
| UP 短按 | 上一帧 |
| UP 长按 | 上一个内容组 |
| DOWN 短按 | 下一帧 |
| DOWN 长按 | 下一个内容组 |
| ENTER 短按 | 下一帧 |
| ENTER 长按 | 设置页 |
| ENTER 双击 | 小智语音页 |
| UP + DOWN 同时按 | 紧急全屏刷新，清残影 |

Scene：

```text
BootSplashScene      启动、配网、注册、等待绑定/内容组
BgRefreshScene       timer wake 后台刷新
FrameScene           常规显示与翻页
XiaozhiScene         小智语音对话
SettingsScene        设置页
  ├─ VolumePage      音量调节
  ├─ DeviceInfoPage
  ├─ RestartDevicePage
  └─ FactoryResetPage
```

## EPD

关键参数：

- 400 x 300，1bpp packed 帧为 15000 bytes。
- SSD2683 实际刷屏需要 2bpp 传输，1bpp 会膨胀成 30 KB SPI payload。
- 全刷约 2-3 秒，局刷约 0.3-0.6 秒。
- 累计多次 partial 后强制 full cleanup，减少残影。
- BUSY 极性是 active-low：低=忙，高=空闲。
- 读屏内温度后写温度补偿寄存器，60 秒内复用温度，避免每次 RX 切换开销。

deep sleep 前只等待已有 EPD refresh 完成，不主动全刷；屏幕内容依靠墨水屏双稳态保留。

## 音频

`AudioPlayer` 初始化 I2S0 duplex：

- 16 kHz
- mono
- 16-bit
- MCLK = 256 x fs
- TX 用于内容音频和小智下行播放
- RX 用于小智麦克风上行

ES8311 使用 lazy open：

1. 初始化时创建 codec handle，但不立即 open。
2. 第一次播放或语音进入时 open codec。
3. DAC bias 等 100 ms 后再拉高 GPIO46 PA。
4. 切歌前静音并等待 DMA 残留，减少爆音。

内容音频格式与后端一致：

```text
16 kHz mono signed 16-bit little-endian raw PCM
```

内容播放和小智对话共用同一个音量设置。

## 小智语音

`xiaozhi/` 子系统包含：

- `config/`：`activation_client` / `settings`，向小智配置服务获取 MQTT/WebSocket 配置与 activation 信息，并保存 UUID、协议配置、音量等 NVS 设置。
- `mcp/`：`mcp_dispatcher` / `mcp_tools`，MCP 协议分发与工具注册。
- `protocol/`：`protocol` / `mqtt_protocol` / `websocket_protocol` / `audio_stream_packet`，对话协议。
- `service/`：`xiaozhi_service`、`xiaozhi_phase`、`audio_service`、`message_handler`，对话状态机、麦克风、播放、语音处理。

进入方式：ENTER 双击打开 `XiaozhiScene`。如果尚无协议配置，会先走配置/激活流程；配置完成后进入待机。语音活动、配置任务或播放中会阻止 deep sleep。

## 休眠与唤醒

`SleepManager` 策略：

- 默认闲置 10 分钟 deep sleep，可由 `SLATE_IDLE_DEEP_SLEEP_MIN` 配置。
- captive portal 模式禁用 deep sleep。
- USB/充电存在时暂停 deep sleep。
- 未绑定后 2 小时内阻止 deep sleep，方便用户在 Web claim 后设备快速响应；低电量会退出 grace。
- 小智活动中阻止 deep sleep。

唤醒源：

- ENTER / GPIO0
- DOWN / GPIO18
- CHARGE_DETECT / GPIO2
- RTC timer（仅当前动态帧需要定时刷新时启用）

GPIO39 上键不是 RTC IO，不能作为 deep sleep ext1 唤醒源。

进入 deep sleep 前：

1. 停止小智、同步和音频。
2. 等待 EPD 当前刷新完成，保存状态栏快照。
3. 关闭 EPD rail。
4. 关闭音频/I2C rail。
5. 使用 RTC GPIO hold 住 GPIO17 主电源。
6. 配置 ext1 和可选 timer。

## 配置项

[main/Kconfig.projbuild](main/Kconfig.projbuild)：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `SLATE_BOARD_ID` | `zectrix-note4` | 编译期真实板型；CI/release 通过 matrix 写入临时 `SDKCONFIG_DEFAULTS` |
| `SLATE_DEFAULT_SERVER_URL` | 空 | captive portal 服务端 URL 预填值 |
| `SLATE_AP_SSID_PREFIX` | `Slate` | SoftAP SSID 前缀 |
| `SLATE_DEFAULT_TIMEZONE` | `CST-8` | SNTP 后设置的 POSIX TZ |
| `SLATE_IDLE_DEEP_SLEEP_MIN` | `10` | 闲置多少分钟进 deep sleep |

`sdkconfig.defaults` 还固化：

- ESP32-S3 target
- 16 MB QIO Flash
- 8 MB Octal PSRAM
- LittleFS 分区表
- LVGL 9.5
- TLS root CA bundle
- mbedTLS dynamic buffer 与 external mem alloc
- DFS 80-240 MHz
- tickless idle
- deep sleep leakage workaround

## 依赖

[main/idf_component.yml](main/idf_component.yml)：

```yaml
espressif/button: ~4.1.5
espressif/esp_codec_dev: ~1.5.6
78/esp-ml307: ~3.6.5
espressif/esp_audio_codec: ~2.4.1
espressif/esp_audio_effects: ~1.2.1
lvgl/lvgl: ~9.5.0
espressif/esp_lvgl_port: ~2.7.2
joltwallet/littlefs: ~1.16.0
idf: ">=5.5"
```

## 字体

固件内置字体在 `main/resources/fonts/`：

- `zfull_16.c`
- `zfull_12.c`
- `font_awesome_14_1.c`
- `font_awesome_30_1.c`

生成脚本：

```bash
firmware/tools/gen_zfull_fonts.sh
```

## 调试要点

- HTTP base URL 接受 `http://` 和 `https://`；authenticated HTTP 会打印警告。
- HTTPS 需要 SNTP 时间同步，否则证书校验可能失败。
- `/api/v2` 前缀写死在 `sync/manifest_contract.cc`，要与 shared/backend 保持一致。
- EPD BUSY 是低忙高闲，调试新屏或新板时不要按 SSD1683 datasheet 默认极性判断。
- AVDD_3V3 关闭后 I2C 上拉消失，任何 I2C 操作都会失败。
- deep sleep 前 GPIO17 必须切 RTC GPIO hold 高，否则会整机断电，按键唤不醒。
