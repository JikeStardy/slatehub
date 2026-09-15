#include "power/power_state.h"

#include <esp_attr.h>
#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

#include <cstring>

#include "bsp/board_platform.h"
#include "power/status_bar_snapshot_identity.h"
#include "utils/scoped_mutex_lock.h"

namespace power_state {
namespace {

constexpr char kTag[] = "power_state";

// 最小 wake 间隔：太短会把 deep sleep 的省电优势磨没。
constexpr uint32_t kMinWakeIntervalSec = 60u;

// RTC slow memory 持久化变量。深睡跨越保留；cold boot 由 Init(true) 显式清零。
RTC_DATA_ATTR bool     s_frame_dynamic         = false;
RTC_DATA_ATTR uint32_t s_frame_server_sync_sec = 0;
RTC_DATA_ATTR int      s_current_frame_seq     = 0;

// 连续 timer wake 未能联系上服务器(WiFi/后端不可达,或 sync 失败)的次数。
// 用于指数退避下次 RTC timer 间隔,避免网络长期不可用时每 60s 空醒耗电。
// 成功同步清零;cold boot 清零;深睡跨越保留(退避需跨唤醒累计)。
RTC_DATA_ATTR uint32_t s_timer_wake_fail_count = 0;

// 退避位移上限:60s << 6 ≈ 64min,与下方 kMaxBackoffWakeSec 共同封顶。
constexpr uint32_t kMaxBackoffShift   = 6;
constexpr uint64_t kMaxBackoffWakeSec = 3600;

constexpr uint32_t     kStatusBarSnapshotMagic                             = 0x53544231u;  // "STB1"
RTC_DATA_ATTR uint32_t s_status_bar_magic                                  = 0;
RTC_DATA_ATTR uint32_t s_status_bar_hash                                   = 0;
RTC_DATA_ATTR uint32_t s_status_bar_len                                    = 0;
RTC_DATA_ATTR uint32_t s_status_bar_board_hash                             = 0;
RTC_DATA_ATTR uint32_t s_status_bar_profile_hash                           = 0;
RTC_DATA_ATTR int      s_status_bar_width                                  = 0;
RTC_DATA_ATTR int      s_status_bar_height                                 = 0;
RTC_DATA_ATTR int      s_status_bar_region_x                               = 0;
RTC_DATA_ATTR int      s_status_bar_region_y                               = 0;
RTC_DATA_ATTR int      s_status_bar_region_width                           = 0;
RTC_DATA_ATTR int      s_status_bar_region_height                          = 0;
RTC_DATA_ATTR uint32_t s_status_bar_pixel_format                           = 0;
RTC_DATA_ATTR uint32_t s_status_bar_codec                                  = 0;
RTC_DATA_ATTR uint8_t  s_status_bar_snapshot[board::kStatusBarSnapshotCapacityBytes] = {};

SemaphoreHandle_t StateMutex() {
    static StaticSemaphore_t s_mutex_buf;
    static SemaphoreHandle_t s_mutex = xSemaphoreCreateMutexStatic(&s_mutex_buf);
    return s_mutex;
}

uint32_t NormalizeDynamicWakeSec(uint32_t sec) {
    return sec < kMinWakeIntervalSec ? kMinWakeIntervalSec : sec;
}

uint32_t HashBytes(const uint8_t* data, size_t len) {
    uint32_t h = 2166136261u;
    for (size_t i = 0; i < len; ++i) {
        h ^= data[i];
        h *= 16777619u;
    }
    return h;
}

uint32_t HashString(const char* value) {
    return HashSnapshotString(value);
}

bool SnapshotIdentityMatches(const display::DisplayInfo& display_info, const display::FrameRegion& region, size_t len) {
    const StatusBarSnapshotIdentity stored{s_status_bar_len,
                                           s_status_bar_board_hash,
                                           s_status_bar_profile_hash,
                                           s_status_bar_width,
                                           s_status_bar_height,
                                           s_status_bar_pixel_format,
                                           s_status_bar_codec,
                                           s_status_bar_region_x,
                                           s_status_bar_region_y,
                                           s_status_bar_region_width,
                                           s_status_bar_region_height};
    return StatusBarSnapshotIdentityMatches(stored, display_info, region, len);
}

}  // namespace

void Init(bool cold_boot) {
    if (!cold_boot)
        return;
    ScopedMutexLock lock(StateMutex());
    s_frame_dynamic         = false;
    s_frame_server_sync_sec = 0;
    s_current_frame_seq     = 0;
    s_timer_wake_fail_count = 0;
    s_status_bar_magic         = 0;
    s_status_bar_hash          = 0;
    s_status_bar_len           = 0;
    s_status_bar_board_hash    = 0;
    s_status_bar_profile_hash  = 0;
    s_status_bar_width         = 0;
    s_status_bar_height        = 0;
    s_status_bar_region_x      = 0;
    s_status_bar_region_y      = 0;
    s_status_bar_region_width  = 0;
    s_status_bar_region_height = 0;
    s_status_bar_pixel_format  = 0;
    s_status_bar_codec         = 0;
    std::memset(s_status_bar_snapshot, 0, sizeof(s_status_bar_snapshot));
}

CurrentFrameSchedule GetCurrentFrameSchedule() {
    CurrentFrameSchedule schedule;
    ScopedMutexLock      lock(StateMutex());
    schedule.dynamic         = s_frame_dynamic;
    schedule.server_sync_sec = s_frame_server_sync_sec;
    return schedule;
}

void SetCurrentFrameSchedule(const CurrentFrameSchedule& schedule) {
    ScopedMutexLock lock(StateMutex());
    s_frame_dynamic         = schedule.dynamic;
    s_frame_server_sync_sec = schedule.dynamic ? NormalizeDynamicWakeSec(schedule.server_sync_sec) : 0;
}

int GetCurrentFrameSeq() {
    ScopedMutexLock lock(StateMutex());
    const int       seq = s_current_frame_seq;
    return seq < 0 ? 0 : seq;
}

void SetCurrentFrameSeq(int seq) {
    ScopedMutexLock lock(StateMutex());
    s_current_frame_seq = seq < 0 ? 0 : seq;
}

void SetCurrentFrameFromMeta(int seq, const cache::FrameMeta& meta) {
    CurrentFrameSchedule schedule;
    schedule.dynamic         = meta.has_ttl;
    schedule.server_sync_sec = meta.ttl_sec;
    SetCurrentFrameSchedule(schedule);
    SetCurrentFrameSeq(seq);
    // flash 去重：current_frame_seq 仅在与已持久化值不同时才写。后台定时刷新每次唤醒
    // 都展示同一帧，旧实现每次都写 LittleFS，长期磨损 flash；读取不伤寿命，先读再判。
    int persisted = 0;
    if (cache::ReadCurrentFrameSeq(persisted) && persisted == seq)
        return;
    cache::WriteCurrentFrameSeq(seq);
}

void ClearCurrentFrame() {
    SetCurrentFrameSchedule({});
    SetCurrentFrameSeq(0);
    cache::WriteCurrentFrameSeq(0);
}

bool RestoreCurrentFrameScheduleFromCache() {
    std::string gid;
    std::string etag;
    if (!cache::ReadStateMeta(gid, etag) || gid.empty()) {
        ClearCurrentFrame();
        return false;
    }

    int content_count = 0;
    if (!cache::ReadManifestContentCount(gid, content_count) || content_count <= 0) {
        ClearCurrentFrame();
        return false;
    }

    int seq = 0;
    cache::ReadCurrentFrameSeq(seq);
    if (seq < 0 || seq >= content_count)
        seq = 0;

    cache::FrameMeta meta;
    if (!cache::ReadFrameMeta(gid, seq, meta)) {
        SetCurrentFrameSchedule({});
        SetCurrentFrameSeq(seq);
        return false;
    }

    SetCurrentFrameFromMeta(seq, meta);
    return true;
}

bool CurrentFrameNeedsTimerWake() {
    ScopedMutexLock lock(StateMutex());
    const bool      needs_wake = s_frame_dynamic && s_frame_server_sync_sec > 0;
    return needs_wake;
}

uint32_t ComputeNextWakeSec() {
    ScopedMutexLock lock(StateMutex());
    const bool      dynamic         = s_frame_dynamic;
    const uint32_t  server_sync_sec = s_frame_server_sync_sec;

    if (!dynamic) {
        return 0;
    }
    const uint32_t next  = NormalizeDynamicWakeSec(server_sync_sec);
    const uint32_t shift = s_timer_wake_fail_count > kMaxBackoffShift ? kMaxBackoffShift : s_timer_wake_fail_count;
    // 不可达退避:连续 timer wake 失败时指数拉长下次唤醒,封顶 kMaxBackoffWakeSec。
    const uint64_t backed = static_cast<uint64_t>(next) << shift;
    return static_cast<uint32_t>(backed > kMaxBackoffWakeSec ? kMaxBackoffWakeSec : backed);
}

void RecordTimerWakeResult(bool success) {
    ScopedMutexLock lock(StateMutex());
    if (success) {
        s_timer_wake_fail_count = 0;
    } else if (s_timer_wake_fail_count < kMaxBackoffShift) {
        ++s_timer_wake_fail_count;
    }
}

bool SaveStatusBarSnapshot(const display::DisplayInfo& display_info, const display::FrameRegion& region,
                           const uint8_t* data, size_t len) {
    if (!data || len == 0 || len > board::kStatusBarSnapshotCapacityBytes)
        return false;
    const uint32_t  hash = HashBytes(data, len);
    ScopedMutexLock lock(StateMutex());
    // magic 是提交标记:先清无效,写完 snapshot/hash 后再恢复,Load 只接受完整快照。
    s_status_bar_magic = 0;
    std::memcpy(s_status_bar_snapshot, data, len);
    s_status_bar_hash         = hash;
    s_status_bar_len          = static_cast<uint32_t>(len);
    s_status_bar_board_hash   = HashString(display_info.board_id);
    s_status_bar_profile_hash = HashString(display_info.profile_id);
    s_status_bar_width        = display_info.frame.width;
    s_status_bar_height       = display_info.frame.height;
    s_status_bar_region_x      = region.x;
    s_status_bar_region_y      = region.y;
    s_status_bar_region_width  = region.width;
    s_status_bar_region_height = region.height;
    s_status_bar_pixel_format = static_cast<uint32_t>(display_info.frame.pixel_format);
    s_status_bar_codec        = static_cast<uint32_t>(display_info.frame.codec);
    s_status_bar_magic        = kStatusBarSnapshotMagic;
    ESP_LOGD(kTag, "saved status bar snapshot hash=%08lx", static_cast<unsigned long>(hash));
    return true;
}

bool LoadStatusBarSnapshot(const display::DisplayInfo& display_info, const display::FrameRegion& region, uint8_t* out,
                           size_t len) {
    if (!out || len == 0 || len > board::kStatusBarSnapshotCapacityBytes)
        return false;
    uint32_t magic = 0;
    uint32_t hash  = 0;
    {
        ScopedMutexLock lock(StateMutex());
        magic = s_status_bar_magic;
        hash  = s_status_bar_hash;
        if (magic == kStatusBarSnapshotMagic && SnapshotIdentityMatches(display_info, region, len)) {
            std::memcpy(out, s_status_bar_snapshot, len);
        } else if (magic == kStatusBarSnapshotMagic) {
            s_status_bar_magic = 0;
            magic              = 0;
        }
    }
    if (magic != kStatusBarSnapshotMagic)
        return false;
    return HashBytes(out, len) == hash;
}

void ClearStatusBarSnapshot() {
    ScopedMutexLock lock(StateMutex());
    s_status_bar_magic        = 0;
    s_status_bar_hash         = 0;
    s_status_bar_len          = 0;
    s_status_bar_board_hash   = 0;
    s_status_bar_profile_hash = 0;
    s_status_bar_width        = 0;
    s_status_bar_height       = 0;
    s_status_bar_region_x      = 0;
    s_status_bar_region_y      = 0;
    s_status_bar_region_width  = 0;
    s_status_bar_region_height = 0;
    s_status_bar_pixel_format = 0;
    s_status_bar_codec        = 0;
}

}  // namespace power_state
