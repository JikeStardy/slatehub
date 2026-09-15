#pragma once

// 顶层 App。把所有子系统按依赖顺序串起来：
//   Storage → Board → Audio → EventBus → SceneStack → ui_loop task →
//   Inputs(按键/充电→EventBus) → MinuteBoundaryTicker → Network → SleepManager → PM
//
// Run() 等同 vTaskDelete(NULL)：把 main task 的 8 KB 栈让出来，
// 由各后台 task（ui_loop / sync / charge_tick / audio / epd_refresh）继续跑。

#include <atomic>
#include <memory>
#include <string>

#include "drivers/input/up_down_combo.h"
#include "events/event_bus.h"
#include "network/cred_store.h"
#include "power/minute_boundary_ticker.h"
#include "power/sleep_manager.h"
#include "scenes/core/scene_stack.h"
#include "startup/boot_mode.h"

class CaptivePortal;

class App {
   public:
    App();
    ~App();
    void Init();
    void Run();

   private:
    void InitStorage();
    void InitDevices();
    void InitEventBus();
    void InitSceneStack();
    void StartUiLoop();
    void AttachInputs();
    void StartMinuteBoundaryTicker();
    bool InitWifiAndSync(cred::Credentials& creds, bool background_refresh);
    bool ReadBattery(int* mv, int* pct);
    void StartSleep();
    void FinalizePm();
    // 按当前供电/模式决定是否启用自动 light sleep，并应用 PM 配置。充电状态变化时重调。
    void ConfigurePm(bool light_sleep_enable);
    bool ShouldEnableLightSleep(bool power_present) const;

    void StartPortal();
    void PostWakeupKeyEvent(uint64_t ext1_mask);
    void PromoteToFrameSceneFromCache();
    bool HandleSecretInvalid(const UiEvent& e);
    bool HandleBackgroundRefreshDone(const UiEvent& e);
    bool CompleteBackgroundRefreshSleep();
    bool HandleXiaozhiChannelClosed(const UiEvent& e);
    bool HandleInitialGroupReady(const UiEvent& e);
    bool HandleEnterDoubleClick(const UiEvent& e);

    static void UiLoopEntry(void* arg);
    void        UiLoopTask();

    SceneStack                     scene_stack_;
    SleepManager                   sleep_mgr_;
    MinuteBoundaryTicker           minute_ticker_;
    UpDownComboController          up_down_combo_;
    std::unique_ptr<CaptivePortal> portal_;
    std::atomic<bool>              ui_loop_running_{false};
    boot_mode::Decision            decision_;
};
