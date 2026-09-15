#include "sync/sync_service.h"

#include <esp_log.h>
#include <sdkconfig.h>

#include "bsp/board.h"
#include "events/event_bus.h"
#include "network/sntp.h"
#include "network/wifi.h"
#include "power/power_state.h"
#include "sync/sync_internal.h"
#include "utils/time_utils.h"

using sync_internal::kTag;

namespace {

api::Telemetry BuildTelemetry(const std::string& current_group, const std::string& wake_reason) {
    api::Telemetry tel;
    uint16_t       mv  = 0;
    uint8_t        pct = 0;
    if (Board::Get().ReadBattery(&mv, &pct)) {
        tel.battery_pct = pct;
        evt::PostBatteryUpdated(mv, pct, evt::kNoWait);
    }
    tel.rssi_dbm            = Wifi::Get().GetRssi();
    tel.fw_version          = CONFIG_APP_PROJECT_VER;
    tel.wake_reason         = wake_reason;
    tel.current_group       = current_group;
    tel.current_content_seq = power_state::CurrentFrameNeedsTimerWake() ? power_state::GetCurrentFrameSeq() : -1;
    if (tel.current_content_seq >= 0) {
        std::string      gid;
        std::string      manifest_etag;
        cache::FrameMeta meta;
        if (cache::ReadStateMeta(gid, manifest_etag) && !gid.empty() &&
            cache::ReadFrameMeta(gid, tel.current_content_seq, meta)) {
            tel.current_content_etag = meta.content_etag;
        }
    }
    tel.manifest_etag = cache::ReadCurrentManifestEtag(Board::Get().platform().Display());
    return tel;
}

}  // namespace

bool SyncService::ClearSelectedGroup() {
    ClearCurrentGroup();
    power_state::ClearCurrentFrame();
    return cache::WriteStateMeta("", "");
}

bool SyncService::SyncBackground(const api::DeviceState& state, const api::Telemetry& telemetry, bool& group_changed) {
    if (!state.has_group)
        return ClearSelectedGroup();

    if (telemetry.manifest_etag != state.manifest_etag) {
        return SyncManifestAndFrames(state.group_id, state.manifest_etag, state.group_name, state.content_count,
                                     SyncReason::kBackgroundRefresh, group_changed);
    }

    if (!state.has_current_content) {
        ESP_LOGW(kTag, "background refresh missing current_content action=keep_cached_schedule");
        power_state::RestoreCurrentFrameScheduleFromCache();
        return telemetry.current_content_seq < 0;
    }

    const bool ok = SyncCurrentContent(state.group_id, state.current_content, group_changed);
    if (ok && group_changed) {
        PostSyncedGroupReady(state.group_id, state.group_name, state.content_count, /*content_changed=*/true);
    }
    return ok;
}

bool SyncService::SyncUserActive(const api::DeviceState& state, bool& group_changed) {
    if (!state.has_group)
        return ClearSelectedGroup();

    return SyncManifestAndFrames(state.group_id, state.manifest_etag, state.group_name, state.content_count,
                                 SyncReason::kUserActive, group_changed);
}

void SyncService::SyncOnce(SyncMode mode) {
    const int64_t started_ms = time_utils::NowMs();
    ESP_LOGI(kTag, "sync start mode=%s", SyncModeName(mode));
    std::string telemetry_group = CurrentGroupSnapshot();
    if (mode == SyncMode::kBackgroundRefresh) {
        power_state::RestoreCurrentFrameScheduleFromCache();
        std::string gid, etag;
        if (cache::ReadStateMeta(gid, etag))
            telemetry_group = gid;
    }

    evt::PostSyncStarted(evt::kNoWait);

    api::Telemetry tel = BuildTelemetry(telemetry_group, wake_reason_);
    if (ShouldStop())
        return;

    api::DeviceState state;
    if (!api::Poll(tel, state)) {
        if (ShouldStop())
            return;
        ESP_LOGW(kTag, "poll failed reason=offline_or_server");
        ESP_LOGI(kTag, "sync done mode=%s ok=0 group_changed=0 elapsed_ms=%lld", SyncModeName(mode),
                 (long long)(time_utils::NowMs() - started_ms));
        evt::PostSyncFinished(false, false, evt::kNoWait);
        return;
    }
    if (ShouldStop())
        return;
    sntp::ApplyServerTime(state.server_time);

    const BoundState prev_bound = was_bound_.load();
    const BoundState next_bound = state.bound ? BoundState::kBound : BoundState::kUnbound;
    if (next_bound != prev_bound) {
        if (state.bound) {
            evt::PostSimple(UiEventKind::kBound, evt::kNoWait);
        } else {
            ESP_LOGW(kTag, "device unbound");
            evt::PostUnbound(state.pair_code, evt::kNoWait);
        }
        was_bound_.store(next_bound);
        if (state.bound) {
            unbound_since_ms_.store(0);
        } else {
            unbound_since_ms_.store(time_utils::NowMs());
        }
    }

    if (!state.bound) {
        evt::PostBootStage(BootStage::kAwaitingPair, nullptr, state.pair_code.c_str(), evt::kNoWait);
    } else if (!state.has_group) {
        evt::PostBootStage(BootStage::kAwaitingGroup, nullptr, nullptr, evt::kNoWait);
    }

    bool       group_changed = false;
    const bool sync_ok       = mode == SyncMode::kBackgroundRefresh ? SyncBackground(state, tel, group_changed)
                                                                    : SyncUserActive(state, group_changed);

    ESP_LOGI(kTag, "sync done mode=%s ok=%d group_changed=%d elapsed_ms=%lld", SyncModeName(mode), sync_ok ? 1 : 0,
             group_changed ? 1 : 0, (long long)(time_utils::NowMs() - started_ms));
    evt::PostSyncFinished(sync_ok, group_changed, evt::kNoWait);
}

void SyncService::DoCycle(const std::string& direction) {
    const int64_t started_ms = time_utils::NowMs();
    ESP_LOGI(kTag, "cycle start direction=%s", direction.c_str());
    evt::PostSyncStarted(evt::kNoWait);

    api::DeviceState state;
    if (ShouldStop())
        return;
    if (!api::CycleGroup(direction, state)) {
        if (ShouldStop())
            return;
        ESP_LOGW(kTag, "cycle group failed direction=%s reason=offline_or_server", direction.c_str());
        ESP_LOGI(kTag, "cycle done direction=%s ok=0 group_changed=0 elapsed_ms=%lld", direction.c_str(),
                 (long long)(time_utils::NowMs() - started_ms));
        evt::PostSyncFinished(false, false, evt::kNoWait);
        evt::PostGroupSyncStatus(GroupSyncStatusMode::kCycleFailed, "", "");
        return;
    }
    if (ShouldStop())
        return;

    bool group_changed = false;
    bool sync_ok       = true;
    if (state.has_group) {
        evt::PostGroupSyncStatus(GroupSyncStatusMode::kCycleTarget, state.group_id, state.group_name);
        sync_ok = SyncManifestAndFrames(state.group_id, state.manifest_etag, state.group_name, state.content_count,
                                        SyncReason::kCycle, group_changed);
    } else {
        sync_ok = ClearSelectedGroup();
    }

    evt::PostSyncFinished(sync_ok, group_changed, evt::kNoWait);
    if (!sync_ok)
        evt::PostGroupSyncStatus(GroupSyncStatusMode::kCycleFailed, state.group_id, state.group_name);
    ESP_LOGI(kTag, "cycle done direction=%s ok=%d group_changed=%d elapsed_ms=%lld", direction.c_str(), sync_ok ? 1 : 0,
             group_changed ? 1 : 0, (long long)(time_utils::NowMs() - started_ms));
}
