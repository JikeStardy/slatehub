#pragma once

#include <cstddef>
#include <cstdint>
#include <type_traits>

enum class ButtonId : uint8_t { kEnter = 0, kUp, kDown };

// boot 阶段枚举;splash 用此切文案。顺序对应 splash 状态机典型路径。
enum class BootStage : uint8_t {
    kInitializing = 0,
    kProvisioning,       // 无 cred,captive portal 模式
    kWifiConnecting,     // 试连 STA(载荷带 ssid)
    kWifiFailed,         // 试连超时/认证失败
    kSntp,               // 等系统时间对齐
    kRegistering,        // 调 /devices
    kServerUnreachable,  // 服务器 30s 无响应
    kAwaitingPair,       // 注册完毕,等待 Web 端 claim(载荷带 pair_code)
    kAwaitingGroup,      // 已 bound,等待管理端分配内容组
    kNetError,           // 其它网络异常
};

enum class GroupSyncStatusMode : uint8_t {
    kCycleTarget = 0,          // 已拿到主动切换目标
    kCycleCacheHit,            // 主动切换目标命中本地缓存
    kCycleDownloading,         // 正在下载主动切换目标
    kCurrentGroupUpdating,     // 后台刷新正在更新当前内容组
    kInitialGroupDownloading,  // 启动/普通同步正在下载目标内容组
    kTargetGroupSaving,        // 下载后正在保存目标内容组缓存
    kCurrentGroupSaving,       // 下载后正在保存当前内容组缓存
    kCycleFailed,              // 主动切换失败，保留当前内容组
};

namespace evt {
namespace limits {
inline constexpr size_t kGroupIdBytes         = 32;
inline constexpr size_t kGroupSyncNameBytes   = 48;
inline constexpr size_t kGroupNameBytes       = 64;
inline constexpr size_t kWifiSsidBytes        = 33;
inline constexpr size_t kPairCodeBytes        = 8;
inline constexpr int    kMaxGroupContentCount = 100;
}  // namespace limits
}  // namespace evt

enum class UiEventKind : uint8_t {
    kButtonShort,       // u.button.btn
    kButtonLong,        // u.button.btn
    kButtonDouble,      // u.button.btn
    kChargeChanged,     // u.charge
    kBatteryUpdated,    // u.battery
    kWifiStateChanged,  // u.wifi
    kSyncStarted,
    kSyncProgress,      // u.progress { current, total }  帧级下载进度
    kGroupSyncStatus,   // u.group_sync  内容组切换/下载/更新状态
    kSyncFinished,      // u.sync
    kCachedGroupReady,  // u.group
    kSyncedGroupReady,  // u.group
    kMinuteTick,
    kIdleTimeout,
    // 启动阶段进度,由 app.cc TryConnectAndSetup 各步 emit;splash 用 stage 切文案。
    kBootStage,  // u.boot_stage
    // 设备从 unbound 翻 bound:Web 端用户输入了配对码。splash 切「等待内容组」。
    kBound,
    // 设备从 bound 翻 unbound:Web 端主动解绑。任何场景需 RequestReplace 回 splash。
    kUnbound,  // u.unbound { pair_code[8] }
    // poll 收到 401:secret 失效,固件 self-reset 流(清 NVS secret + 重启)。
    kSecretInvalid,
    // RTC timer 唤醒后台刷新场景完成/放弃，App 可立即进入下一轮 deep sleep。
    kBgRefreshDone,
    // 后台刷新 EPD refresh request 已 accepted 且 display idle，BgRefreshScene 在 UI task 提交调度状态。
    kBgRefreshDisplayIdle,
    // Xiaozhi 子系统状态变化。Scene 收到后从 XiaozhiService 读取最新快照。
    kXiaozhiChanged,
    // Xiaozhi 网络/服务端主动关闭。App 收到后转交 XiaozhiService 收束对应会话。
    kXiaozhiChannelClosed,  // u.xiaozhi_channel.token
};

struct UiEvent {
    UiEventKind kind;
    union U {
        struct {
            ButtonId btn;
        } button;
        struct {
            uint8_t state;  // ChargeStatus::State
            bool    present;
            bool    charging;
            bool    full;
            bool    no_battery;
        } charge;
        struct {
            int mv;
            int pct;
        } battery;
        struct {
            bool connected;
            int  rssi;
        } wifi;
        struct {
            bool ok;
            bool group_changed;
        } sync;
        struct {
            uint8_t current;
            uint8_t total;
        } progress;
        struct {
            char                gid[evt::limits::kGroupIdBytes];
            char                name[evt::limits::kGroupSyncNameBytes];
            GroupSyncStatusMode mode;
            uint8_t             current;
            uint8_t             total;
        } group_sync;
        struct {
            char gid[evt::limits::kGroupIdBytes];
            char name[evt::limits::kGroupNameBytes];  // 当前组名（UTF-8），用于状态栏 / boot splash 文案
            int  content_count;
            // true = 本轮 sync 真下载了新 frame(内容变化);false = fast-path/304,只是确认状态。
            // FrameScene 用它决定是否触发 EPD full refresh,避免 30s 心跳每轮都闪屏。
            bool content_changed;
        } group;
        struct {
            BootStage stage;
            char      ssid[evt::limits::kWifiSsidBytes];       // kWifiConnecting 时设 STA SSID
            char      pair_code[evt::limits::kPairCodeBytes];  // kAwaitingPair 时设 6 位 + nul
        } boot_stage;
        struct {
            char pair_code[evt::limits::kPairCodeBytes];
        } unbound;
        struct {
            uint32_t token;
        } xiaozhi_channel;
        struct {
            uint32_t generation;
        } bg_refresh;
        U() : group{} {
        }
    } u;

    UiEvent() : kind(UiEventKind::kMinuteTick), u() {
    }
};

static_assert(std::is_trivially_copyable_v<UiEvent>, "UiEvent must stay byte-copyable for FreeRTOS queues");
static_assert(std::is_standard_layout_v<UiEvent>, "UiEvent must stay layout-stable for FreeRTOS queues");
static_assert(std::is_trivially_destructible_v<UiEvent>, "UiEvent must not own resources in FreeRTOS queues");
static_assert(sizeof(UiEvent) <= 128, "UiEvent queue item grew unexpectedly");
