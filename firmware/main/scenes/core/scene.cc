#include "scenes/core/scene.h"

#include <esp_log.h>
#include <esp_timer.h>

#include "ui/status_bar.h"

namespace {
constexpr char kTag[]        = "scene";
constexpr int  kSlowRenderMs = 500;

int64_t ElapsedMs(int64_t start_us) {
    return (esp_timer_get_time() - start_us) / 1000;
}
}  // namespace

lv_obj_t* Scene::CreateFullscreenRoot() {
    auto* screen = lv_screen_active();
    auto* root   = lv_obj_create(screen);
    lv_obj_set_size(root, LV_HOR_RES, LV_VER_RES);
    lv_obj_set_pos(root, 0, 0);
    lv_obj_set_style_bg_color(root, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(root, LV_OPA_COVER, 0);
    lv_obj_set_style_pad_all(root, 0, 0);
    lv_obj_set_style_border_width(root, 0, 0);
    lv_obj_clear_flag(root, LV_OBJ_FLAG_SCROLLABLE);
    return root;
}

bool Scene::RefreshStatusBarFromSensors(SceneContext& ctx, StatusBar& status_bar) {
    bool changed = false;
    if (ctx.wifi_connected && ctx.wifi_rssi) {
        changed |= status_bar.SetWifi(ctx.wifi_connected(), ctx.wifi_rssi());
    }
    if (ctx.read_charge) {
        const auto snap = ctx.read_charge();
        int        pct  = -1;
        if (!snap.no_battery && ctx.read_battery) {
            int mv = 0;
            ctx.read_battery(&mv, &pct);
        }
        changed |= status_bar.SetBattery(pct, snap.charging, snap.full);
    }
    return changed;
}

bool Scene::RefreshStatusBarAndRender(SceneContext& ctx, StatusBar* status_bar, bool force_full, int timeout_ms) {
    if (!status_bar)
        return false;
    return SyncRenderIfChanged(
        ctx, [this, &ctx, status_bar]() { return RefreshStatusBarFromSensors(ctx, *status_bar); }, force_full,
        timeout_ms);
}

bool Scene::SyncRender(SceneContext& ctx, bool force_full, int timeout_ms) {
    return SyncRender(ctx, {}, force_full, timeout_ms);
}

bool Scene::SyncRender(SceneContext& ctx, std::function<void()> before_refresh, bool force_full, int timeout_ms) {
    const int64_t start_us = esp_timer_get_time();
    ESP_LOGD(kTag, "sync render begin scene=%s force_full=%d timeout_ms=%d", Name(), force_full ? 1 : 0, timeout_ms);
    if (!ctx.epd || !ctx.epd->Lock(timeout_ms)) {
        ESP_LOGW(kTag, "sync render failed reason=lock scene=%s has_epd=%d timeout_ms=%d", Name(), ctx.epd ? 1 : 0,
                 timeout_ms);
        return false;
    }
    if (before_refresh)
        before_refresh();
    ESP_LOGD(kTag, "lvgl refresh begin scene=%s", Name());
    lv_refr_now(NULL);
    ESP_LOGD(kTag, "lvgl refresh done scene=%s", Name());
    ctx.epd->Unlock();
    display::RequestRefreshWithFallback(*ctx.epd,
                                        force_full ? display::PresentMode::kFull : display::PresentMode::kPartial);
    const int64_t elapsed_ms = ElapsedMs(start_us);
    if (elapsed_ms >= kSlowRenderMs) {
        ESP_LOGW(kTag, "render slow scene=%s elapsed_ms=%lld force_full=%d", Name(), static_cast<long long>(elapsed_ms),
                 force_full ? 1 : 0);
    } else {
        ESP_LOGD(kTag, "sync render done scene=%s elapsed_ms=%lld force_full=%d", Name(),
                 static_cast<long long>(elapsed_ms), force_full ? 1 : 0);
    }
    return true;
}

bool Scene::SyncRenderIfChanged(SceneContext& ctx, std::function<bool()> update, bool force_full, int timeout_ms) {
    const int64_t start_us = esp_timer_get_time();
    ESP_LOGD(kTag, "sync render begin scene=%s force_full=%d timeout_ms=%d changed_only=1", Name(), force_full ? 1 : 0,
             timeout_ms);
    if (!ctx.epd || !ctx.epd->Lock(timeout_ms)) {
        ESP_LOGW(kTag, "sync render failed reason=lock scene=%s has_epd=%d timeout_ms=%d", Name(), ctx.epd ? 1 : 0,
                 timeout_ms);
        return false;
    }
    const bool changed = update ? update() : false;
    if (changed) {
        ESP_LOGD(kTag, "lvgl refresh begin scene=%s", Name());
        lv_refr_now(NULL);
        ESP_LOGD(kTag, "lvgl refresh done scene=%s", Name());
    }
    ctx.epd->Unlock();
    if (!changed) {
        ESP_LOGD(kTag, "sync render skip scene=%s reason=unchanged elapsed_ms=%lld", Name(),
                 static_cast<long long>(ElapsedMs(start_us)));
        return false;
    }
    display::RequestRefreshWithFallback(*ctx.epd,
                                        force_full ? display::PresentMode::kFull : display::PresentMode::kPartial);
    const int64_t elapsed_ms = ElapsedMs(start_us);
    if (elapsed_ms >= kSlowRenderMs) {
        ESP_LOGW(kTag, "render slow scene=%s elapsed_ms=%lld force_full=%d", Name(), static_cast<long long>(elapsed_ms),
                 force_full ? 1 : 0);
    } else {
        ESP_LOGD(kTag, "sync render done scene=%s elapsed_ms=%lld force_full=%d", Name(),
                 static_cast<long long>(elapsed_ms), force_full ? 1 : 0);
    }
    return true;
}

bool Scene::DestroyRoot(SceneContext& ctx, lv_obj_t*& root, std::function<void()> cleanup, int timeout_ms) {
    ESP_LOGD(kTag, "destroy root begin scene=%s root=%p timeout_ms=%d", Name(), root, timeout_ms);
    if (!ctx.epd || !ctx.epd->Lock(timeout_ms)) {
        ESP_LOGW(kTag, "destroy root failed reason=lock scene=%s has_epd=%d timeout_ms=%d", Name(), ctx.epd ? 1 : 0,
                 timeout_ms);
        return false;
    }
    if (cleanup)
        cleanup();
    if (root) {
        lv_obj_del(root);
        root = nullptr;
    }
    ctx.epd->Unlock();
    ESP_LOGD(kTag, "destroy root done scene=%s", Name());
    return true;
}
