#include "app/app.h"

#include <esp_log.h>
#include <esp_pm.h>
#include <esp_sleep.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <nvs_flash.h>
#include <sdkconfig.h>

#include <array>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <utility>

#include "bsp/board.h"
#include "bsp/config.h"
#include "drivers/input/button.h"
#include "scenes/bg_refresh/bg_refresh_scene.h"
#include "startup/boot_mode.h"

#include "drivers/audio/audio_player.h"
#include "events/event_bus.h"
#include "events/ui_event_log.h"
#include "network/captive_portal.h"
#include "network/cred_store.h"
#include "network/wifi.h"
#include "power/power_state.h"
#include "power/shutdown.h"
#include "scenes/frame/frame_scene.h"
#include "scenes/splash/splash_scene.h"
#include "scenes/xiaozhi/xiaozhi_scene.h"
#include "startup/setup_flow.h"
#include "storage/cache/cache.h"
#include "sync/api_client.h"
#include "sync/sync_service.h"
#include "utils/time_utils.h"
#include "xiaozhi/service/audio_service.h"
#include "xiaozhi/service/xiaozhi_service.h"

namespace {
constexpr char kTag[] = "app";

ButtonInput MakeButtonInput(Button* button) {
    if (!button)
        return {};
    return ButtonInput{
        [button](ButtonInput::Callback cb) { button->OnPressDown(std::move(cb)); },
        [button](ButtonInput::Callback cb) { button->OnPressUp(std::move(cb)); },
        [button](ButtonInput::Callback cb) { button->OnLongPress(std::move(cb)); },
        [button](ButtonInput::Callback cb) { button->OnClick(std::move(cb)); },
    };
}

void PostChargeSnapshot(const ChargeStatus::Snapshot& snap, TickType_t timeout = pdMS_TO_TICKS(100)) {
    evt::PostChargeChanged(static_cast<uint8_t>(snap.state), snap.power_present, snap.charging, snap.full,
                           snap.no_battery, timeout);
}

bool PostCachedGroupReadyIfAny() {
    cache::CachedGroupSummary summary;
    if (!cache::ReadCachedGroupSummary(summary, Board::Get().platform().Display())) {
        ESP_LOGD(kTag, "cached group missing");
        return false;
    }

    ESP_LOGI(kTag, "cached group ready gid=%s name=%s count=%d", summary.gid.c_str(), summary.name.c_str(),
             summary.content_count);
    evt::PostGroupReady(UiEventKind::kCachedGroupReady, summary.gid, summary.name, summary.content_count,
                        /*content_changed=*/false);
    return true;
}

const char* SleepOutcomeName(SleepManager::SleepOutcome outcome) {
    switch (outcome) {
        case SleepManager::SleepOutcome::kSlept:
            return "slept";
        case SleepManager::SleepOutcome::kPausedByCharge:
            return "paused_by_charge";
        case SleepManager::SleepOutcome::kDisabled:
            return "disabled";
        case SleepManager::SleepOutcome::kUnboundGrace:
            return "unbound_grace";
    }
    return "unknown";
}

void ConfigureLogLevels() {
    // esp_codec_dev prints normal I2S/codec setup details at INFO. Keep third-party
    // style intact, but hide routine startup chatter from the default log stream.
    esp_log_level_set("I2S_IF", ESP_LOG_WARN);
    esp_log_level_set("Adev_Codec", ESP_LOG_WARN);
    esp_log_level_set("ES8311", ESP_LOG_WARN);
    esp_log_level_set("i2s_common", ESP_LOG_WARN);
    esp_log_level_set("pm", ESP_LOG_WARN);
    esp_log_level_set("button", ESP_LOG_WARN);
    esp_log_level_set("LVGL", ESP_LOG_WARN);
    esp_log_level_set("esp-x509-crt-bundle", ESP_LOG_WARN);
}

}  // namespace

App::App()  = default;
App::~App() = default;

// ── 子系统初始化 ─────────────────────────────────────────────────────

void App::InitStorage() {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }
    cache::Init();
}

void App::InitDevices() {
    Board::Get().Init();
    AudioPlayer::Get().Init(Board::Get().i2c_bus());
}

void App::InitEventBus() {
    evt::Init();
}

void App::InitSceneStack() {
    SceneContext ctx;
    ctx.epd   = Board::Get().display();
    ctx.audio = &AudioPlayer::Get();
    ctx.stack = &scene_stack_;

    ctx.read_battery                = [this](int* mv, int* pct) -> bool { return ReadBattery(mv, pct); };
    ctx.read_charge                 = []() { return Board::Get().charge()->Get(); };
    ctx.wifi_connected              = []() { return Wifi::Get().IsConnected(); };
    ctx.wifi_rssi                   = []() -> int { return Wifi::Get().GetRssi(); };
    ctx.current_frame_seq           = []() -> int { return power_state::GetCurrentFrameSeq(); };
    ctx.clear_current_frame         = []() { power_state::ClearCurrentFrame(); };
    ctx.set_current_frame_from_meta = [](int seq, const cache::FrameMeta& meta) {
        power_state::SetCurrentFrameFromMeta(seq, meta);
    };
    ctx.cycle_group = [](bool next) {
        if (next)
            SyncService::Get().CycleNext();
        else
            SyncService::Get().CyclePrev();
    };
    ctx.xiaozhi_service = []() -> xiaozhi::XiaozhiService* { return &xiaozhi::XiaozhiService::Get(); };

    scene_stack_.SetContext(ctx);
}

bool App::ReadBattery(int* mv, int* pct) {
    uint16_t   mv16 = 0;
    uint8_t    p8   = 0;
    const bool ok   = Board::Get().ReadBattery(&mv16, &p8);
    if (mv)
        *mv = mv16;
    if (pct)
        *pct = p8;
    return ok;
}

void App::StartUiLoop() {
    ui_loop_running_.store(true, std::memory_order_release);
    // ui_loop 8 KB：与 home_worker 一致；LVGL render+flush_cb 调用栈装得下，
    // esp_timer task / button cb task 装不下（栈 3584 B）。
    ESP_LOGD(kTag, "task start name=ui_loop");
    BaseType_t ok = xTaskCreatePinnedToCore(&App::UiLoopEntry, "ui_loop", 8 * 1024, this, 5, nullptr, 0);
    configASSERT(ok == pdPASS);
}

void App::UiLoopEntry(void* arg) {
    static_cast<App*>(arg)->UiLoopTask();
}

void App::PostWakeupKeyEvent(uint64_t ext1_mask) {
    ESP_LOGD(kTag, "wake key check ext1_mask=0x%llx", static_cast<unsigned long long>(ext1_mask));
    if (ext1_mask == 0)
        return;
    ButtonId btn;
    if (ext1_mask & (1ULL << DOWN_BUTTON_GPIO))
        btn = ButtonId::kDown;
    else if (ext1_mask & (1ULL << BOOT_BUTTON_GPIO))
        btn = ButtonId::kEnter;
    else
        return;
    ESP_LOGI(kTag, "wake key btn=%s", evt::log::ButtonName(btn));
    evt::PostButton(UiEventKind::kButtonShort, btn);
}

void App::PromoteToFrameSceneFromCache() {
    ESP_LOGD(kTag, "promote from cache");
    if (!PostCachedGroupReadyIfAny()) {
        scene_stack_.Push(std::make_unique<SplashScene>());
    }
}

bool App::HandleSecretInvalid(const UiEvent& e) {
    if (e.kind != UiEventKind::kSecretInvalid)
        return false;
    ESP_LOGW(kTag, "secret invalid action=clear_and_restart");
    cred::ClearSecret();
    power_shutdown::GracefulRestart(200);
    while (true)
        vTaskDelay(portMAX_DELAY);
}

bool App::HandleBackgroundRefreshDone(const UiEvent& e) {
    if (e.kind != UiEventKind::kBgRefreshDone)
        return false;
    Scene* top = scene_stack_.Top();
    if (!top || std::strcmp(top->Name(), "bg_refresh") != 0) {
        ESP_LOGW(kTag, "background refresh done ignored reason=no_current_scene generation=%llu",
                 static_cast<unsigned long long>(e.u.bg_refresh.generation));
        return true;
    }
    auto* bg = static_cast<BgRefreshScene*>(top);
    if (!bg->CompleteDoneEvent(e.u.bg_refresh.generation)) {
        ESP_LOGW(kTag, "background refresh done ignored reason=generation_mismatch generation=%llu",
                 static_cast<unsigned long long>(e.u.bg_refresh.generation));
        return true;
    }
    return CompleteBackgroundRefreshSleep();
}

bool App::CompleteBackgroundRefreshSleep() {
    ESP_LOGI(kTag, "background refresh done");
    auto d = sleep_mgr_.TryEnterDeepSleep();
    ESP_LOGI(kTag, "sleep decision outcome=%s next_sec=%u", SleepOutcomeName(d.outcome),
             static_cast<unsigned>(d.configured_next_wake_sec));
    switch (d.outcome) {
        case SleepManager::SleepOutcome::kSlept:
            break;
        case SleepManager::SleepOutcome::kPausedByCharge:
            scene_stack_.Pop();
            PromoteToFrameSceneFromCache();
            SyncService::Get().RequestUserActiveSync();
            break;
        case SleepManager::SleepOutcome::kUnboundGrace:
            scene_stack_.Pop();
            scene_stack_.Push(std::make_unique<SplashScene>());
            SyncService::Get().RequestUserActiveSync();
            break;
        case SleepManager::SleepOutcome::kDisabled:
            ESP_LOGW(kTag, "sleep disabled action=promote_active");
            scene_stack_.Pop();
            PromoteToFrameSceneFromCache();
            break;
    }
    return true;
}

bool App::HandleXiaozhiChannelClosed(const UiEvent& e) {
    if (e.kind != UiEventKind::kXiaozhiChannelClosed)
        return false;
    ESP_LOGD(kTag, "xiaozhi channel closed token=%lu", static_cast<unsigned long>(e.u.xiaozhi_channel.token));
    xiaozhi::XiaozhiService::Get().NotifyNetworkClosed(e.u.xiaozhi_channel.token);
    return true;
}

bool App::HandleInitialGroupReady(const UiEvent& e) {
    if ((e.kind != UiEventKind::kCachedGroupReady && e.kind != UiEventKind::kSyncedGroupReady) ||
        !scene_stack_.Empty()) {
        return false;
    }
    ESP_LOGI(kTag, "initial group ready gid=%s name=%s count=%d", e.u.group.gid, e.u.group.name,
             e.u.group.content_count);
    scene_stack_.Push(std::make_unique<FrameScene>(scene_stack_.Context(), e.u.group.gid, e.u.group.content_count));
    scene_stack_.ApplyPending();
    return true;
}

bool App::HandleEnterDoubleClick(const UiEvent& e) {
    if (e.kind != UiEventKind::kButtonDouble || e.u.button.btn != ButtonId::kEnter)
        return false;
    Scene* top = scene_stack_.Top();
    ESP_LOGD(kTag, "button double btn=enter action=xiaozhi_or_delegate top=%s", top ? top->Name() : "(none)");
    if (top && top->IsSettings()) {
        scene_stack_.Dispatch(e);
        sleep_mgr_.OnEvent(e);
        scene_stack_.ApplyPending();
        return true;
    }
    if (!top || std::strcmp(top->Name(), "xiaozhi") != 0) {
        scene_stack_.Push(std::make_unique<XiaozhiScene>());
        scene_stack_.ApplyPending();
        sleep_mgr_.OnEvent(e);
        return true;
    }
    return false;
}

void App::UiLoopTask() {
    ESP_LOGD(kTag, "ui loop start mode=%s wake=%s", evt::log::BootModeName(decision_.mode),
             evt::log::WakeCauseName(decision_.wake_cause));
    switch (decision_.mode) {
        case boot_mode::Mode::kPortal:
        case boot_mode::Mode::kFullActive:
            ESP_LOGD(kTag, "initial scene scene=splash");
            scene_stack_.Push(std::make_unique<SplashScene>());
            break;
        case boot_mode::Mode::kBackgroundRefresh:
            ESP_LOGD(kTag, "initial scene scene=bg_refresh");
            scene_stack_.Push(std::make_unique<BgRefreshScene>());
            break;
    }

    while (ui_loop_running_.load(std::memory_order_acquire)) {
        UiEvent e;
        if (!evt::Wait(&e, pdMS_TO_TICKS(1000))) {
            // 1s 超时只是为了让 SleepManager 有机会做 Tick；不强制每秒做事。
            sleep_mgr_.Tick(time_utils::NowMs());
            continue;
        }
        if (evt::log::DebugEnabled(kTag)) {
            char detail[128];
            evt::log::Describe(e, detail, sizeof(detail));
            ESP_LOGD(kTag, "event handle kind=%s detail=%s top=%s", evt::log::KindName(e.kind), detail,
                     scene_stack_.Top() ? scene_stack_.Top()->Name() : "(none)");
        }
        using Handler                                           = bool (App::*)(const UiEvent&);
        static constexpr std::array<Handler, 5> kSystemHandlers = {
            &App::HandleSecretInvalid,     &App::HandleBackgroundRefreshDone, &App::HandleXiaozhiChannelClosed,
            &App::HandleInitialGroupReady, &App::HandleEnterDoubleClick,
        };
        bool handled = false;
        for (Handler handler : kSystemHandlers) {
            if ((this->*handler)(e)) {
                handled = true;
                ESP_LOGD(kTag, "event handled scope=system kind=%s", evt::log::KindName(e.kind));
                break;
            }
        }
        if (handled) {
            ESP_LOGD(kTag, "event done scope=system kind=%s top=%s", evt::log::KindName(e.kind),
                     scene_stack_.Top() ? scene_stack_.Top()->Name() : "(none)");
            continue;
        }
        scene_stack_.Dispatch(e);
        if (e.kind == UiEventKind::kBgRefreshDisplayIdle) {
            Scene* top = scene_stack_.Top();
            if (top && std::strcmp(top->Name(), "bg_refresh") == 0) {
                auto* bg = static_cast<BgRefreshScene*>(top);
                if (bg->IsCompletedGeneration(e.u.bg_refresh.generation)) {
                    CompleteBackgroundRefreshSleep();
                    continue;
                }
            }
        }
        sleep_mgr_.OnEvent(e);
        // 供电状态变化时重配 light sleep：插 USB 关、拔掉(电池)开。
        if (e.kind == UiEventKind::kChargeChanged) {
            ESP_LOGD(kTag, "power mode light_sleep=%d", ShouldEnableLightSleep(e.u.charge.present) ? 1 : 0);
            ConfigurePm(ShouldEnableLightSleep(e.u.charge.present));
        }
        scene_stack_.ApplyPending();
        ESP_LOGD(kTag, "event done kind=%s top=%s", evt::log::KindName(e.kind),
                 scene_stack_.Top() ? scene_stack_.Top()->Name() : "(none)");
    }
    ESP_LOGW(kTag, "ui loop exit");
    vTaskDelete(nullptr);
}

void App::AttachInputs() {
    ESP_LOGD(kTag, "input attach");
    auto post_button = [](UiEventKind kind, ButtonId b) {
        return [kind, b]() {
            ESP_LOGD(kTag, "button event kind=%s btn=%s", evt::log::KindName(kind), evt::log::ButtonName(b));
            evt::PostButton(kind, b);
        };
    };

    auto* board = &Board::Get();

    up_down_combo_.Install(
        MakeButtonInput(board->up_btn()), MakeButtonInput(board->down_btn()),
        [] {
            ESP_LOGI(kTag, "button combo action=full_refresh combo=up_down");
            if (auto* display = Board::Get().display())
                display::RequestRefreshWithFallback(*display, display::PresentMode::kFull);
        },
        post_button(UiEventKind::kButtonShort, ButtonId::kUp), post_button(UiEventKind::kButtonLong, ButtonId::kUp),
        post_button(UiEventKind::kButtonShort, ButtonId::kDown),
        post_button(UiEventKind::kButtonLong, ButtonId::kDown));

    board->boot_btn()->OnClick(post_button(UiEventKind::kButtonShort, ButtonId::kEnter));
    board->boot_btn()->OnDoubleClick(post_button(UiEventKind::kButtonDouble, ButtonId::kEnter));
    // ENTER 长按 1s → frame_scene 接 ButtonLong{kEnter} push SettingsScene。
    board->boot_btn()->OnLongPress(post_button(UiEventKind::kButtonLong, ButtonId::kEnter));

    // 充电状态变化转发到 EventBus（HAL 不直接知道 EventBus 存在）
    Board::Get().charge()->OnStateChanged([](const ChargeStatus::Snapshot& snap) { PostChargeSnapshot(snap); });

    // WiFi 断线转 EventBus（重连成功事件 wifi.cc 内部已处理；这里只接 disconnect）
    Wifi::Get().OnDisconnected([](int /*reason*/) { evt::PostWifiState(false, 0); });
}

void App::StartMinuteBoundaryTicker() {
    ESP_LOGD(kTag, "ticker start name=minute_boundary");
    minute_ticker_.Start();
}

bool App::InitWifiAndSync(cred::Credentials& creds, bool background_refresh) {
    ESP_LOGI(kTag, "network setup start background=%d ssid=%s has_secret=%d", background_refresh ? 1 : 0,
             creds.wifi_ssid.c_str(), creds.device_secret.empty() ? 0 : 1);
    Wifi::Get().Init();

    // poll 收 401 → emit kSecretInvalid;UiLoop 拦下来在主线程清 NVS + esp_restart。
    api::SetUnauthorizedHandler([]() { evt::PostSimple(UiEventKind::kSecretInvalid); });

    if (setup_flow::TryConnectAndSetup(creds)) {
        // 连上 → 状态栏立即显示 wifi 图标
        ESP_LOGI(kTag, "network setup done sync_initial=%s", background_refresh ? "background_refresh" : "user_active");
        evt::PostWifiState(true, Wifi::Get().GetRssi());

        SyncService::Get().Start(decision_.wake_reason, background_refresh
                                                            ? SyncService::InitialSync::kBackgroundRefresh
                                                            : SyncService::InitialSync::kUserActive);
        return true;
    } else {
        ESP_LOGW(kTag, "network setup failed");
        return false;
    }
}

void App::StartPortal() {
    portal_ = std::make_unique<CaptivePortal>();

    portal_->OnSubmit([](const CaptivePortal::Submission& s, std::string& out_error) -> bool {
        std::string reason;
        if (!Wifi::Get().TryConnect(s.ssid, s.password, 10000, reason)) {
            out_error = reason;
            ESP_LOGW(kTag, "wifi try connect failed ssid=%s reason=%s", s.ssid.c_str(), reason.c_str());
            return false;
        }
        cred::Credentials c;
        c.wifi_ssid  = s.ssid;
        c.wifi_pwd   = s.password;
        c.server_url = s.server_url;
        // device_id/device_secret 留空:配网完成 esp_restart 后 InitWifiAndSync 看到无 secret
        // → 走 register 流。设备命名留到 Web 端 PUT /devices/:id 完成绑定后再做。
        if (!cred::Save(c)) {
            out_error = "凭据保存失败,请重试";
            ESP_LOGE(kTag, "credential save failed");
            return false;
        }
        return true;
    });

    portal_->OnFinished([this](bool success) {
        if (!success)
            return;
        portal_->Stop();
        power_shutdown::GracefulRestart(500);
    });

    portal_->Start();
}

void App::StartSleep() {
    // 注册 charge callback 时设备可能已经在充电(USB 接着启动),但 ChargeStatus
    // 内部已经在 Init 时把 snapshot 设到 kCharging,callback 不会因"未变化"而再触发。
    // 这里主动 Post 一次让 SleepManager 同步初始 paused_ 状态,免得"开机就充电"
    // 场景被误判为闲置 5min 后睡。
    auto snap = Board::Get().charge()->Get();
    ESP_LOGD(kTag, "sleep start charge_present=%d charging=%d full=%d no_battery=%d", snap.power_present ? 1 : 0,
             snap.charging ? 1 : 0, snap.full ? 1 : 0, snap.no_battery ? 1 : 0);
    PostChargeSnapshot(snap);
}

bool App::ShouldEnableLightSleep(bool power_present) const {
    // 仅「电池供电 + 非配网门户」时开自动 light sleep：
    //   - USB 供电：关，避免影响 CDC/JTAG 控制台（sleep_cpu_configure 会打 E 级 log）；
    //     且充电时本就暂停深睡，省电意义小。
    //   - 配网门户(SoftAP)：关，AP 模式需保持响应，light sleep 会拖累配网。
    // 音频播放/对话期间由 AudioPlayer 持有 NO_LIGHT_SLEEP 锁，避免 I2S 欠载卡顿。
    return !power_present && decision_.mode != boot_mode::Mode::kPortal;
}

void App::ConfigurePm(bool light_sleep_enable) {
    // DFS（80~240 MHz）始终开；light_sleep_enable 按供电/模式动态切换。
    esp_pm_config_t pm = {
        .max_freq_mhz       = 240,
        .min_freq_mhz       = 80,
        .light_sleep_enable = light_sleep_enable,
    };
    ESP_LOGD(kTag, "power management configure light_sleep=%d", light_sleep_enable ? 1 : 0);
    ESP_ERROR_CHECK(esp_pm_configure(&pm));
}

void App::FinalizePm() {
    const bool power_present = Board::Get().charge()->Get().power_present;
    ESP_LOGD(kTag, "power management finalize power_present=%d", power_present ? 1 : 0);
    ConfigurePm(ShouldEnableLightSleep(power_present));
}

void App::Init() {
    ConfigureLogLevels();
    ESP_LOGI(kTag, "init begin");
    InitStorage();
    InitDevices();
    InitEventBus();
    xiaozhi::XiaozhiService::Get().Start(&AudioPlayer::Get(), &xiaozhi::AudioService::Get());
    InitSceneStack();

    cred::Credentials creds;
    cred::Load(creds);
    power_state::Init(esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_UNDEFINED);
    decision_ = boot_mode::Decide(creds);
    ESP_LOGI(kTag, "boot decision mode=%s wake=%s reason=%s ext1=0x%llx first_register=%d",
             evt::log::BootModeName(decision_.mode), evt::log::WakeCauseName(decision_.wake_cause),
             decision_.wake_reason.c_str(), static_cast<unsigned long long>(decision_.ext1_mask),
             decision_.first_register ? 1 : 0);

    SleepManager::Policy policy;
    policy.idle_timeout_min = CONFIG_SLATEHUB_IDLE_DEEP_SLEEP_MIN;
    policy.disabled         = (decision_.mode == boot_mode::Mode::kPortal);
    sleep_mgr_.Init(policy);
    // 阻止深睡的两个来源：语音会话活动中、以及一次 sync 突发(大文件下载)进行中。
    // 任一持续阻塞超过 SleepManager 看门狗上限时会被强制打断回睡，避免卡死耗光电池。
    sleep_mgr_.SetSleepBlocker(
        []() { return xiaozhi::XiaozhiService::Get().BlocksSleep() || SyncService::Get().IsBusy(); });
    power_shutdown::SetPreShutdownHook([]() { xiaozhi::XiaozhiService::Get().SuspendForSleep(); });

    StartUiLoop();
    AttachInputs();
    StartMinuteBoundaryTicker();
    StartSleep();

    switch (decision_.mode) {
        case boot_mode::Mode::kPortal:
            ESP_LOGD(kTag, "mode portal");
            Wifi::Get().Init();
            StartPortal();
            break;
        case boot_mode::Mode::kBackgroundRefresh: {
            ESP_LOGD(kTag, "mode background_refresh");
            const bool net_ok = InitWifiAndSync(creds, true);
            if (!net_ok) {
                ESP_LOGW(kTag, "background refresh network failed action=deep_sleep");
                // 联系不上服务器：递增退避计数，下次 timer wake 间隔指数拉长，避免空醒。
                power_state::RecordTimerWakeResult(false);
                UiEvent done{};
                done.kind                    = UiEventKind::kBgRefreshDone;
                done.u.bg_refresh.generation = 0;
                evt::Post(done, evt::kNoWait);
            }
            break;
        }
        case boot_mode::Mode::kFullActive: {
            ESP_LOGD(kTag, "mode full_active");
            const bool net_ok = InitWifiAndSync(creds, false);
            if (net_ok && !decision_.first_register) {
                PostCachedGroupReadyIfAny();
                if (decision_.wake_cause == boot_mode::WakeCause::kButton) {
                    PostWakeupKeyEvent(decision_.ext1_mask);
                }
            }
            if (!net_ok) {
                ESP_LOGW(kTag, "fallback action=captive_portal");
                StartPortal();
                sleep_mgr_.Disable();
            }
            break;
        }
    }

    FinalizePm();
    ESP_LOGI(kTag, "init done");
}

void App::Run() {
    // main task Init 完毕。释放栈，让 ui_loop / sync / charge_tick / audio / epd_refresh
    // 各自后台跑。直接 return 会被 IDF abort，必须 vTaskDelete。
    ESP_LOGD(kTag, "task delete name=main");
    vTaskDelete(nullptr);
}
