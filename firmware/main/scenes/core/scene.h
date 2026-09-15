#pragma once

// Scene 抽象 + SceneContext。
// 所有可见 UI = 一个 Scene；多个 Scene 用 SceneStack 堆叠。启动态可以是
// SplashScene / BgRefreshScene / FrameScene，具体由 App 的 boot_mode 决定。
// Scene 的所有方法仅由 ui_loop task 调用（OnEnter/OnExit/OnEvent）。

#include <lvgl.h>
#include <functional>
#include <string>

#include "bsp/charge_status.h"
#include "drivers/display/display_contract.h"

namespace cache {
struct FrameMeta;
}

namespace xiaozhi {
class XiaozhiService;
}

class StatusBar;
class AudioPlayer;
class SceneStack;

struct UiEvent;

struct SceneContext {
    display::Display* epd   = nullptr;
    AudioPlayer*      audio = nullptr;
    SceneStack*       stack = nullptr;

    // 数据访问通过依赖注入，Scene 不直接抓 Board / Wifi 单例。
    std::function<bool(int* mv, int* pct)>  read_battery;
    std::function<ChargeStatus::Snapshot()> read_charge;
    std::function<bool()>                   wifi_connected;
    std::function<int()>                    wifi_rssi;

    std::function<int()>                                       current_frame_seq;
    std::function<void()>                                      clear_current_frame;
    std::function<void(int seq, const cache::FrameMeta& meta)> set_current_frame_from_meta;
    std::function<void(bool next)>                             cycle_group;
    std::function<xiaozhi::XiaozhiService*()>                  xiaozhi_service;
};

class Scene {
   public:
    virtual ~Scene()                 = default;
    virtual const char* Name() const = 0;

    virtual void OnEnter(SceneContext& ctx) {
    }
    virtual void OnExit(SceneContext& ctx) {
    }
    virtual void OnEvent(SceneContext& ctx, const UiEvent& e) {
    }

    virtual bool IsSettings() const {
        return false;
    }

    virtual lv_obj_t* Root() = 0;
    virtual bool      RequiresRoot() const {
        return true;
    }

   protected:
    lv_obj_t* CreateFullscreenRoot();
    bool      RefreshStatusBarFromSensors(SceneContext& ctx, StatusBar& status_bar);
    bool      RefreshStatusBarAndRender(SceneContext& ctx, StatusBar* status_bar, bool force_full = false,
                                        int timeout_ms = 500);
    bool      SyncRender(SceneContext& ctx, bool force_full = false, int timeout_ms = 500);
    bool      SyncRender(SceneContext& ctx, std::function<void()> before_refresh, bool force_full = false,
                         int timeout_ms = 500);
    bool      SyncRenderIfChanged(SceneContext& ctx, std::function<bool()> update, bool force_full = false,
                                  int timeout_ms = 500);
    bool      DestroyRoot(SceneContext& ctx, lv_obj_t*& root, std::function<void()> cleanup = {}, int timeout_ms = 500);
};
