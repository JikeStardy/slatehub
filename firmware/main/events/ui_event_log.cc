#include "events/ui_event_log.h"

#include <esp_log_level.h>

#include <cstdio>

namespace evt::log {

const char* ButtonName(ButtonId btn) {
    switch (btn) {
        case ButtonId::kEnter:
            return "enter";
        case ButtonId::kUp:
            return "up";
        case ButtonId::kDown:
            return "down";
    }
    return "unknown";
}

const char* KindName(UiEventKind kind) {
    switch (kind) {
        case UiEventKind::kButtonShort:
            return "button_short";
        case UiEventKind::kButtonLong:
            return "button_long";
        case UiEventKind::kButtonDouble:
            return "button_double";
        case UiEventKind::kChargeChanged:
            return "charge_changed";
        case UiEventKind::kBatteryUpdated:
            return "battery_updated";
        case UiEventKind::kWifiStateChanged:
            return "wifi_state_changed";
        case UiEventKind::kSyncStarted:
            return "sync_started";
        case UiEventKind::kSyncProgress:
            return "sync_progress";
        case UiEventKind::kGroupSyncStatus:
            return "group_sync_status";
        case UiEventKind::kSyncFinished:
            return "sync_finished";
        case UiEventKind::kCachedGroupReady:
            return "cached_group_ready";
        case UiEventKind::kSyncedGroupReady:
            return "synced_group_ready";
        case UiEventKind::kMinuteTick:
            return "minute_tick";
        case UiEventKind::kIdleTimeout:
            return "idle_timeout";
        case UiEventKind::kBootStage:
            return "boot_stage";
        case UiEventKind::kBound:
            return "bound";
        case UiEventKind::kUnbound:
            return "unbound";
        case UiEventKind::kSecretInvalid:
            return "secret_invalid";
        case UiEventKind::kBgRefreshDone:
            return "bg_refresh_done";
        case UiEventKind::kBgRefreshDisplayIdle:
            return "bg_refresh_display_idle";
        case UiEventKind::kXiaozhiChanged:
            return "xiaozhi_changed";
        case UiEventKind::kXiaozhiChannelClosed:
            return "xiaozhi_channel_closed";
    }
    return "unknown";
}

const char* BootStageName(BootStage stage) {
    switch (stage) {
        case BootStage::kInitializing:
            return "initializing";
        case BootStage::kProvisioning:
            return "provisioning";
        case BootStage::kWifiConnecting:
            return "wifi_connecting";
        case BootStage::kWifiFailed:
            return "wifi_failed";
        case BootStage::kSntp:
            return "sntp";
        case BootStage::kRegistering:
            return "registering";
        case BootStage::kServerUnreachable:
            return "server_unreachable";
        case BootStage::kAwaitingPair:
            return "awaiting_pair";
        case BootStage::kAwaitingGroup:
            return "awaiting_group";
        case BootStage::kNetError:
            return "net_error";
    }
    return "unknown";
}

const char* GroupSyncStatusModeName(GroupSyncStatusMode mode) {
    switch (mode) {
        case GroupSyncStatusMode::kCycleTarget:
            return "cycle_target";
        case GroupSyncStatusMode::kCycleCacheHit:
            return "cycle_cache_hit";
        case GroupSyncStatusMode::kCycleDownloading:
            return "cycle_downloading";
        case GroupSyncStatusMode::kCurrentGroupUpdating:
            return "current_group_updating";
        case GroupSyncStatusMode::kInitialGroupDownloading:
            return "initial_group_downloading";
        case GroupSyncStatusMode::kTargetGroupSaving:
            return "target_group_saving";
        case GroupSyncStatusMode::kCurrentGroupSaving:
            return "current_group_saving";
        case GroupSyncStatusMode::kCycleFailed:
            return "cycle_failed";
    }
    return "unknown";
}

const char* WakeCauseName(boot_mode::WakeCause cause) {
    switch (cause) {
        case boot_mode::WakeCause::kColdBoot:
            return "cold_boot";
        case boot_mode::WakeCause::kButton:
            return "button";
        case boot_mode::WakeCause::kCharge:
            return "charge";
        case boot_mode::WakeCause::kRtcTimer:
            return "rtc_timer";
        case boot_mode::WakeCause::kOther:
            return "other";
    }
    return "unknown";
}

const char* BootModeName(boot_mode::Mode mode) {
    switch (mode) {
        case boot_mode::Mode::kPortal:
            return "portal";
        case boot_mode::Mode::kBackgroundRefresh:
            return "background_refresh";
        case boot_mode::Mode::kFullActive:
            return "full_active";
    }
    return "unknown";
}

bool DebugEnabled(const char* tag) {
    return esp_log_level_get(tag) >= ESP_LOG_DEBUG;
}

void Describe(const UiEvent& e, char* out, size_t cap) {
    if (!out || cap == 0)
        return;

    switch (e.kind) {
        case UiEventKind::kButtonShort:
        case UiEventKind::kButtonLong:
        case UiEventKind::kButtonDouble:
            std::snprintf(out, cap, "btn=%s", ButtonName(e.u.button.btn));
            break;
        case UiEventKind::kChargeChanged:
            std::snprintf(out, cap, "state=%u present=%d charging=%d full=%d no_battery=%d",
                          static_cast<unsigned>(e.u.charge.state), e.u.charge.present ? 1 : 0,
                          e.u.charge.charging ? 1 : 0, e.u.charge.full ? 1 : 0, e.u.charge.no_battery ? 1 : 0);
            break;
        case UiEventKind::kBatteryUpdated:
            std::snprintf(out, cap, "mv=%d pct=%d", e.u.battery.mv, e.u.battery.pct);
            break;
        case UiEventKind::kWifiStateChanged:
            std::snprintf(out, cap, "connected=%d rssi=%d", e.u.wifi.connected ? 1 : 0, e.u.wifi.rssi);
            break;
        case UiEventKind::kSyncFinished:
            std::snprintf(out, cap, "ok=%d group_changed=%d", e.u.sync.ok ? 1 : 0, e.u.sync.group_changed ? 1 : 0);
            break;
        case UiEventKind::kSyncProgress:
            std::snprintf(out, cap, "current=%u total=%u", static_cast<unsigned>(e.u.progress.current),
                          static_cast<unsigned>(e.u.progress.total));
            break;
        case UiEventKind::kGroupSyncStatus:
            std::snprintf(out, cap, "mode=%s gid=%s name=%s current=%u total=%u",
                          GroupSyncStatusModeName(e.u.group_sync.mode), e.u.group_sync.gid, e.u.group_sync.name,
                          static_cast<unsigned>(e.u.group_sync.current), static_cast<unsigned>(e.u.group_sync.total));
            break;
        case UiEventKind::kCachedGroupReady:
        case UiEventKind::kSyncedGroupReady:
            std::snprintf(out, cap, "gid=%s name=%s count=%d changed=%d", e.u.group.gid, e.u.group.name,
                          e.u.group.content_count, e.u.group.content_changed ? 1 : 0);
            break;
        case UiEventKind::kBootStage:
            std::snprintf(out, cap, "stage=%s ssid=%s pair=%s", BootStageName(e.u.boot_stage.stage),
                          e.u.boot_stage.ssid, e.u.boot_stage.pair_code);
            break;
        case UiEventKind::kUnbound:
            std::snprintf(out, cap, "pair=%s", e.u.unbound.pair_code);
            break;
        case UiEventKind::kXiaozhiChannelClosed:
            std::snprintf(out, cap, "token=%lu", static_cast<unsigned long>(e.u.xiaozhi_channel.token));
            break;
        case UiEventKind::kBgRefreshDone:
        case UiEventKind::kBgRefreshDisplayIdle:
            std::snprintf(out, cap, "generation=%llu",
                          static_cast<unsigned long long>(e.u.bg_refresh.generation));
            break;
        default:
            std::snprintf(out, cap, "-");
            break;
    }
}

}  // namespace evt::log
